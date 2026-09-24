/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { type ParsedStatusProto, parseStatusProto } from "./statusProto";
import type { WriteToken } from "./types";
export interface SaveContext {
    tokens: WriteToken[];
    expected: ParsedStatusProto | null;
    correlated: boolean;
}
export type SaveAckResult = "succeeded" | "unavailable" | "ignored";
export interface SaveAckOutcome { state: SaveAckResult; tokens: WriteToken[]; }

function statusFields(proto: any) {
    const parsed = parseStatusProto(proto);
    return parsed.hasStatus ? parsed : null;
}

function matchesStatus(expected: ParsedStatusProto, actual: ReturnType<typeof statusFields>) {
    if (!actual || expected.configured !== actual.configured) return false;
    if (expected.hasExpiresAtMs && (!actual.hasExpiresAtMs || expected.expiresAtMs !== actual.expiresAtMs)) return false;
    if (expected.hasCreatedAtMs && (!actual.hasCreatedAtMs || expected.createdAtMs !== actual.createdAtMs)) return false;
    return true;
}

/** Identity follows the updater callback through the exact generated partial proto. */
export class Provenance {
    private callbacks = new WeakMap<object, WriteToken>();
    private updates = new WeakMap<object, WriteToken>();
    private updaterTokens = new WeakMap<object, { token: WriteToken; expected: ParsedStatusProto | null }[]>();
    private activeTokens = new Set<WriteToken>();
    private latestLocalToken: WriteToken | null = null;
    private supersededTokens = new WeakSet<WriteToken>();
    private saveAcks = new WeakSet<object>();
    register(callback: object, token: WriteToken) { this.callbacks.set(callback, token); }
    generated(callback: object, proto: unknown) {
        const token = this.callbacks.get(callback);
        if (token && proto && typeof proto === "object") this.updates.set(proto, token);
    }
    take(proto: unknown) {
        if (!proto || typeof proto !== "object") return undefined;
        const token = this.updates.get(proto);
        this.updates.delete(proto);
        if (token) {
            if (this.latestLocalToken && this.latestLocalToken !== token) this.supersededTokens.add(this.latestLocalToken);
            this.latestLocalToken = token;
        }
        return token;
    }
    saveQueued(updater: object, proto: object) {
        const token = this.updates.get(proto);
        if (!token) return undefined;
        const queue = this.updaterTokens.get(updater) ?? [];
        if (!queue.some(entry => entry.token === token)) queue.push({ token, expected: statusFields(proto) });
        this.updaterTokens.set(updater, queue);
        this.activeTokens.add(token);
        return token;
    }
    saveStarted(updater: object, proto: unknown): SaveContext | undefined {
        const parsed = parseStatusProto(proto);
        if (!parsed.mentionsStatus) return undefined;
        const fields = parsed.hasStatus ? parsed : null;
        const queue = this.updaterTokens.get(updater) ?? [];
        const active = queue.filter(entry => this.activeTokens.has(entry.token) && !this.supersededTokens.has(entry.token));
        if (!active.length) return undefined;
        if (fields) {
            const matches = active.filter(entry => entry.expected !== null && entry.token.target === fields.configured && matchesStatus(entry.expected, fields));
            if (matches.length === 1) return { tokens: [matches[0].token], expected: fields, correlated: true };
            const sameTarget = active.filter(entry => entry.token.target === fields.configured);
            const candidates = matches.length > 1 ? matches : sameTarget.length ? sameTarget : active;
            return { tokens: candidates.map(entry => entry.token), expected: fields, correlated: false };
        }
        // A status-bearing request with an unsupported shape must keep its
        // active plugin tokens so either terminal outcome can pause them.
        return { tokens: active.map(entry => entry.token), expected: null, correlated: false };
    }
    private liveTokens(tokens: WriteToken[]) {
        return [...new Set(tokens)].filter(token => this.activeTokens.has(token));
    }
    private retire(updater: object, tokens: WriteToken[]) {
        const retiring = new Set(tokens);
        for (const token of retiring) this.activeTokens.delete(token);
        const queue = this.updaterTokens.get(updater) ?? [];
        this.updaterTokens.set(updater, queue.filter(entry => !retiring.has(entry.token)));
    }
    saveSucceeded(updater: object, context: SaveContext | undefined, proto: object): SaveAckOutcome {
        if (!context) return { state: "ignored", tokens: [] };
        const active = this.liveTokens(context.tokens);
        if (!active.length) return { state: "ignored", tokens: [] };
        const eligible = active.filter(token => !this.supersededTokens.has(token));
        this.retire(updater, active);
        if (!eligible.length) return { state: "ignored", tokens: [] };
        if (!context.correlated || context.tokens.length !== 1 || eligible.length !== 1 || !context.expected || !matchesStatus(context.expected, statusFields(proto))) {
            return { state: "unavailable", tokens: eligible };
        }
        this.saveAcks.add(proto);
        return { state: "succeeded", tokens: eligible };
    }
    takeSaveAck(proto: unknown) {
        if (!proto || typeof proto !== "object" || !this.saveAcks.has(proto)) return false;
        this.saveAcks.delete(proto);
        return true;
    }
    saveFailed(updater: object, context: SaveContext | undefined, retrying: boolean): WriteToken[] {
        if (!context) return [];
        const active = this.liveTokens(context.tokens);
        if (!active.length) return [];
        const superseded = active.filter(token => this.supersededTokens.has(token));
        if (superseded.length) this.retire(updater, superseded);
        const eligible = active.filter(token => !this.supersededTokens.has(token));
        if (retrying) return eligible;
        this.retire(updater, eligible);
        return eligible;
    }
    clear() {
        this.callbacks = new WeakMap(); this.updates = new WeakMap();
        this.updaterTokens = new WeakMap(); this.activeTokens.clear(); this.latestLocalToken = null; this.supersededTokens = new WeakSet(); this.saveAcks = new WeakSet();
    }
}
