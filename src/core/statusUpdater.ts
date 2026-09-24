/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { statusMutator, WriteCancelledBeforeMutation } from "./mutator";
import type { Status, WriteToken } from "./types";

export const PRELOADED_SETTINGS_TYPE = 1;
export const PRELOADED_SETTINGS_PROTO = "discord_protos.discord_users.v1.PreloadedUserSettings";
export const STATUS_SETTINGS_PROTO = "discord_protos.discord_users.v1.StatusSettings";

export type UpdaterReadiness = "ready" | "not_found" | "metadata_mismatch" | "schema_mismatch" | "patches_unavailable";
export type WritePhase = "updater_loading" | "mutation_started" | "locally_applied" | "save_pending" | "save_succeeded" | "failed" | "confirmation_missing" | "cancelled" | "unavailable";
export type WriteOutcome = "pending" | "locally_applied" | "save_pending" | "save_confirmed" | "failed" | "cancelled" | "unavailable";
export type WriteErrorCode = "status_updater_missing" | "status_updater_identity_changed" | "status_updater_schema_rejected" | "status_draft_unsupported" | "status_update_failed" | "local_confirmation_missing" | "save_failed" | "save_acknowledgement_unavailable";

export interface LastWriteDiagnostic {
    operation: number;
    target: Status;
    phase: WritePhase;
    requestedAt: number;
    updatedAt: number;
    outcome: WriteOutcome;
    errorCode?: WriteErrorCode;
}

type AnyRecord = Record<string, any>;
export interface StatusUpdaterResolution {
    instance: AnyRecord | null;
    type: number | null;
    readiness: UpdaterReadiness;
}

export interface GuardedStatusWriteOptions {
    updater: AnyRecord | null;
    currentUpdater(): AnyRecord | null;
    ready(): boolean;
    token: WriteToken;
    guard(): boolean;
    delay: number;
    register(callback: object, token: WriteToken, updater: object): void;
    trace: StatusWriteTrace;
    now(): number;
}

function record(value: unknown): value is AnyRecord {
    return !!value && typeof value === "object";
}

export function hasUpdaterMethods(value: unknown): value is AnyRecord {
    try { return record(value) && typeof value.updateAsync === "function" && typeof value.markDirty === "function"; }
    catch { return false; }
}

function exactMetadata(value: unknown): value is AnyRecord {
    try {
        return hasUpdaterMethods(value)
            && value.type === PRELOADED_SETTINGS_TYPE
            && value.ProtoClass?.typeName === PRELOADED_SETTINGS_PROTO;
    } catch { return false; }
}

function fieldName(field: AnyRecord) {
    return field.localName ?? field.name;
}

function messageType(field: AnyRecord): AnyRecord | null {
    if (field.kind !== "message") return null;
    try {
        const getter = Object.values(field).find(value => typeof value === "function") as (() => unknown) | undefined;
        const value = getter?.();
        return record(value) ? value : null;
    } catch { return null; }
}

function field(proto: AnyRecord, name: string, number: number): AnyRecord | null {
    if (!Array.isArray(proto.fields)) return null;
    const found = proto.fields.filter((candidate: unknown) => record(candidate) && fieldName(candidate) === name && candidate.no === number);
    return found.length === 1 ? found[0] : null;
}

export function supportsStatusSchema(protoClass: unknown): boolean {
    try {
        if (!record(protoClass) || protoClass.typeName !== PRELOADED_SETTINGS_PROTO) return false;
        const rootStatus = field(protoClass, "status", 11);
        const statusSettings = rootStatus && messageType(rootStatus);
        if (!statusSettings || statusSettings.typeName !== STATUS_SETTINGS_PROTO) return false;
        const statusValue = field(statusSettings, "status", 1);
        const wrapper = statusValue && messageType(statusValue);
        if (!wrapper || typeof wrapper.typeName !== "string" || !/(^|\.)StringValue$/.test(wrapper.typeName)) return false;
        const scalar = field(wrapper, "value", 1);
        return !!scalar && scalar.kind !== "message";
    } catch { return false; }
}

function patchedMethods(instance: AnyRecord) {
    const source = (method: unknown) => typeof method === "function" ? Function.prototype.toString.call(method) : "";
    const update = source(instance.updateAsync);
    const dirty = source(instance.markDirty);
    const persist = source(instance.persistChanges);
    return update.includes("generatedUpdate(")
        && dirty.includes("saveQueued(")
        && persist.includes("saveStarted(")
        && persist.includes("saveSucceeded(")
        && persist.includes("saveUnavailable(")
        && persist.includes("saveFailed(");
}

/** Select by semantic settings identity rather than generic method presence. */
export function resolveStatusUpdater(candidates: unknown[]): StatusUpdaterResolution {
    const unique = [...new Set(candidates.filter(hasUpdaterMethods))];
    const matching = unique.filter(exactMetadata);
    if (matching.length !== 1) {
        return { instance: null, type: null, readiness: unique.length ? "metadata_mismatch" : "not_found" };
    }
    const instance = matching[0];
    const type = Number.isInteger(instance.type) ? instance.type as number : null;
    if (!supportsStatusSchema(instance.ProtoClass)) return { instance, type, readiness: "schema_mismatch" };
    if (!patchedMethods(instance)) return { instance, type, readiness: "patches_unavailable" };
    return { instance, type, readiness: "ready" };
}

export function updaterCandidatePredicate(value: unknown): boolean {
    try { return exactMetadata(value); }
    catch { return false; }
}

export function isStatusSettingsEventType(type: unknown): boolean {
    return type === PRELOADED_SETTINGS_TYPE;
}

export function classifyWriteError(error: unknown): WriteErrorCode {
    const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
    if (message === "status_updater_unavailable") return "status_updater_missing";
    if (message === "local_confirmation_missing") return "local_confirmation_missing";
    if (message === "status_shape_unknown") return "status_draft_unsupported";
    if (/Unknown proto field name status/i.test(message)) return "status_updater_schema_rejected";
    return "status_update_failed";
}

/** Apply one configured-status write through the exact resolved raw updater. */
export async function writeConfiguredStatus(options: GuardedStatusWriteOptions): Promise<void> {
    const { updater, currentUpdater, ready, token, guard, delay, register, trace, now } = options;
    const operation = trace.begin(token, now());
    if (!updater || !ready()) {
        trace.update(token, "unavailable", "unavailable", now(), "status_updater_missing");
        throw Error("status_updater_unavailable");
    }
    const operationGuard = () => currentUpdater() === updater && ready() && guard();
    const mutate = statusMutator(token.target, operationGuard);
    const callback = (draft: unknown) => {
        if (!operationGuard()) {
            trace.update(token, "cancelled", "cancelled", now(), currentUpdater() === updater ? undefined : "status_updater_identity_changed");
            throw new WriteCancelledBeforeMutation();
        }
        trace.update(token, "mutation_started", "pending", now());
        return mutate(draft);
    };
    register(callback, token, updater);
    try {
        await updater.updateAsync("status", callback, delay);
        // The dispatch is synchronous; Flux delivers its acknowledgement in the
        // microtask queued by the update before this continuation resumes.
        await Promise.resolve();
        const last = trace.lastWrite;
        if (!trace.hasLocalConfirmation(token)) {
            if (last?.operation === operation && !["failed", "cancelled", "unavailable"].includes(last.phase)) {
                trace.update(token, "confirmation_missing", "unavailable", now(), "local_confirmation_missing");
            }
            throw Error("local_confirmation_missing");
        }
    } catch (error) {
        if (error instanceof WriteCancelledBeforeMutation) {
            trace.update(token, "cancelled", "cancelled", now(), currentUpdater() === updater ? undefined : "status_updater_identity_changed");
        } else {
            const last = trace.lastWrite;
            if (last?.operation !== operation || !["failed", "cancelled", "unavailable"].includes(last.phase)) {
                trace.update(token, "failed", "failed", now(), classifyWriteError(error));
            }
        }
        throw error;
    }
}

const PHASE_ORDER: Record<WritePhase, number> = {
    updater_loading: 0,
    mutation_started: 1,
    locally_applied: 2,
    save_pending: 3,
    save_succeeded: 4,
    failed: 5,
    confirmation_missing: 5,
    cancelled: 5,
    unavailable: 5
};

export class StatusWriteTrace {
    private sequence = 0;
    private operations = new WeakMap<WriteToken, number>();
    private localConfirmations = new WeakSet<WriteToken>();
    private current: LastWriteDiagnostic | null = null;

    get lastWrite(): LastWriteDiagnostic | null { return this.current ? { ...this.current } : null; }
    hasLocalConfirmation(token: WriteToken) { return this.localConfirmations.has(token); }

    begin(token: WriteToken, at: number) {
        const operation = ++this.sequence;
        this.operations.set(token, operation);
        this.current = { operation, target: token.target, phase: "updater_loading", requestedAt: at, updatedAt: at, outcome: "pending" };
        return operation;
    }

    update(token: WriteToken, phase: WritePhase, outcome: WriteOutcome, at: number, errorCode?: WriteErrorCode) {
        const operation = this.operations.get(token);
        if (!operation || this.current?.operation !== operation) return false;
        if (phase === "locally_applied") this.localConfirmations.add(token);
        if (["save_succeeded", "failed", "confirmation_missing", "cancelled", "unavailable"].includes(this.current.phase)) return true;
        if (PHASE_ORDER[phase] < PHASE_ORDER[this.current.phase]) return true;
        this.current = { ...this.current, phase, updatedAt: at, outcome, ...(errorCode ? { errorCode } : { errorCode: undefined }) };
        return true;
    }
}

export function sanitizeLastWrite(value: unknown): LastWriteDiagnostic | null {
    if (!record(value)) return null;
    const phases: WritePhase[] = ["updater_loading", "mutation_started", "locally_applied", "save_pending", "save_succeeded", "failed", "confirmation_missing", "cancelled", "unavailable"];
    const outcomes: WriteOutcome[] = ["pending", "locally_applied", "save_pending", "save_confirmed", "failed", "cancelled", "unavailable"];
    const errors: WriteErrorCode[] = ["status_updater_missing", "status_updater_identity_changed", "status_updater_schema_rejected", "status_draft_unsupported", "status_update_failed", "local_confirmation_missing", "save_failed", "save_acknowledgement_unavailable"];
    if (!Number.isSafeInteger(value.operation) || value.operation < 1
        || !["online", "idle", "dnd"].includes(value.target)
        || !phases.includes(value.phase) || !outcomes.includes(value.outcome)
        || !Number.isFinite(value.requestedAt) || value.requestedAt < 0
        || !Number.isFinite(value.updatedAt) || value.updatedAt < value.requestedAt) return null;
    const errorCode = errors.includes(value.errorCode) ? value.errorCode as WriteErrorCode : undefined;
    return {
        operation: value.operation,
        target: value.target as Status,
        phase: value.phase,
        requestedAt: value.requestedAt,
        updatedAt: value.updatedAt,
        outcome: value.outcome,
        ...(errorCode ? { errorCode } : {})
    };
}
