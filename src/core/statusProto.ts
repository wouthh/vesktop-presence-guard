/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { type Status,status } from "./types";

export interface ParsedStatusProto {
    shape: "group" | "root" | "unsupported" | "none";
    mentionsStatus: boolean;
    hasStatus: boolean;
    configured: Status;
    hasDuration: boolean;
    hasExpiresAtMs: boolean;
    hasCreatedAtMs: boolean;
    expiresAtMs?: string | null;
    createdAtMs?: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): unknown {
    if (object(value) && Object.hasOwn(value, "value")) return value.value;
    return value;
}

export function normalizeConfiguredStatus(value: unknown): Status {
    return status(scalar(value));
}

function timestamp(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const raw = scalar(value);
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
    if (typeof raw === "string" && /^(0|[1-9]\d{0,15})$/.test(raw)) return raw;
    return undefined;
}

function durationFields(containers: Record<string, unknown>[]) {
    const read = (key: "statusExpiresAtMs" | "statusCreatedAtMs") => {
        const values = containers.filter(container => Object.hasOwn(container, key)).map(container => timestamp(container[key]));
        if (!values.length) return { present: false, value: null as string | null | undefined };
        if (values.some(value => value === undefined) || new Set(values).size !== 1) return { present: true, value: undefined };
        return { present: true, value: values[0] };
    };
    const expires = read("statusExpiresAtMs");
    const created = read("statusCreatedAtMs");
    return { expires, created, valid: expires.value !== undefined && created.value !== undefined };
}

export function parseStatusProto(proto: unknown): ParsedStatusProto {
    if (!object(proto)) return { shape: "none", mentionsStatus: false, hasStatus: false, configured: "unknown", hasDuration: false, hasExpiresAtMs: false, hasCreatedAtMs: false };
    const outerStatus = proto.status;
    const group = object(outerStatus) ? outerStatus : null;
    const groupFieldPresent = !!group && Object.hasOwn(group, "value");
    const rootContainerPresent = !!group && Object.hasOwn(group, "status");
    const nestedStatus = group && object(group.status) ? group.status : null;
    const rootFieldPresent = !!nestedStatus && Object.hasOwn(nestedStatus, "value");
    const groupConfigured = groupFieldPresent ? normalizeConfiguredStatus(group) : "unknown";
    const rootConfigured = rootFieldPresent ? normalizeConfiguredStatus(nestedStatus) : "unknown";
    const groupShape = groupFieldPresent;
    const rootShape = rootFieldPresent;
    const mentionsStatus = Object.hasOwn(proto, "status");
    const invalidGroup = groupFieldPresent && groupConfigured === "unknown";
    const invalidRoot = rootContainerPresent && (!nestedStatus || !rootFieldPresent || rootConfigured === "unknown");
    if (invalidGroup || invalidRoot || groupFieldPresent && rootContainerPresent) {
        return { shape: "unsupported", mentionsStatus: true, hasStatus: false, configured: "unknown", hasDuration: false, hasExpiresAtMs: false, hasCreatedAtMs: false };
    }
    if (!groupShape && !rootShape) {
        const hasDuration = [proto, ...(group ? [group] : [])].some(container => Object.hasOwn(container, "statusExpiresAtMs") || Object.hasOwn(container, "statusCreatedAtMs"));
        return { shape: mentionsStatus || hasDuration ? "unsupported" : "none", mentionsStatus: mentionsStatus || hasDuration, hasStatus: false, configured: "unknown", hasDuration: false, hasExpiresAtMs: false, hasCreatedAtMs: false };
    }
    const shape = rootShape ? "root" : "group";
    // Duration metadata may live beside the status in either supported
    // envelope as well as on the outer update object. Identical duplicated
    // fields are accepted; conflicting or malformed wrappers fail closed.
    const containers = [group!, proto];
    const durations = durationFields(containers);
    if (!durations.valid) return { shape: "unsupported", mentionsStatus: true, hasStatus: false, configured: "unknown", hasDuration: durations.expires.present || durations.created.present, hasExpiresAtMs: durations.expires.present, hasCreatedAtMs: durations.created.present };
    return {
        shape,
        mentionsStatus: true,
        hasStatus: true,
        configured: rootShape ? rootConfigured : groupConfigured,
        hasDuration: durations.expires.present || durations.created.present,
        hasExpiresAtMs: durations.expires.present,
        hasCreatedAtMs: durations.created.present,
        expiresAtMs: durations.expires.value,
        createdAtMs: durations.created.value
    };
}

export function configuredStatusSignature(value: unknown, expiresAtMs: unknown, createdAtMs: unknown): string | null {
    const configured = normalizeConfiguredStatus(value);
    const expires = expiresAtMs === undefined ? null : timestamp(expiresAtMs);
    const created = createdAtMs === undefined ? null : timestamp(createdAtMs);
    if (configured === "unknown" || expires === undefined || created === undefined) return null;
    return JSON.stringify([configured, expires, created]);
}
