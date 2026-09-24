/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { type ParsedStatusProto,parseStatusProto } from "./statusProto";
import type { WriteToken } from "./types";
export interface SaveContext {
    token: WriteToken;
    expected: ParsedStatusProto;
}
export type SaveAckResult = "succeeded" | "unavailable" | "ignored";

function statusFields(proto: any) {
    const parsed = parseStatusProto(proto);
    return parsed.hasStatus ? parsed : null;
}

function matchesStatus(expected: SaveContext["expected"], actual: ReturnType<typeof statusFields>) {
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
        const fields = statusFields(proto);
        const queue = this.updaterTokens.get(updater) ?? [];
        if (!fields) return undefined;
        const matches = queue.filter(entry => this.activeTokens.has(entry.token) && !this.supersededTokens.has(entry.token)
            && entry.token.target === fields.configured && (!entry.expected || matchesStatus(entry.expected, fields)));
        if (matches.length !== 1) return undefined;
        return { token: matches[0].token, expected: fields };
    }
    saveSucceeded(updater: object, context: SaveContext | undefined, proto: object): SaveAckResult {
        if (!context || !this.activeTokens.has(context.token)) return "ignored";
        this.activeTokens.delete(context.token);
        const queue = this.updaterTokens.get(updater) ?? [];
        this.updaterTokens.set(updater, queue.filter(entry => entry.token !== context.token));
        if (this.supersededTokens.has(context.token)) return "ignored";
        if (!matchesStatus(context.expected, statusFields(proto))) return "unavailable";
        this.saveAcks.add(proto);
        return "succeeded";
    }
    takeSaveAck(proto: unknown) {
        if (!proto || typeof proto !== "object" || !this.saveAcks.has(proto)) return false;
        this.saveAcks.delete(proto);
        return true;
    }
    saveFailed(updater: object, context: SaveContext | undefined, retrying: boolean) {
        if (!context || retrying || !this.activeTokens.has(context.token)) return;
        this.activeTokens.delete(context.token);
        const queue = this.updaterTokens.get(updater) ?? [];
        this.updaterTokens.set(updater, queue.filter(entry => entry.token !== context.token));
    }
    clear() {
        this.callbacks = new WeakMap(); this.updates = new WeakMap();
        this.updaterTokens = new WeakMap(); this.activeTokens.clear(); this.latestLocalToken = null; this.supersededTokens = new WeakSet(); this.saveAcks = new WeakSet();
    }
}
