/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { WriteToken } from "./types";
export interface SaveContext {
    token: WriteToken;
    expected: { value: unknown; expiresAtMs?: unknown; createdAtMs?: unknown };
}

function statusFields(proto: any) {
    if (!proto?.status || typeof proto.status !== "object") return null;
    return { value: proto.status.value, expiresAtMs: proto.statusExpiresAtMs, createdAtMs: proto.statusCreatedAtMs };
}

function matchesStatus(expected: SaveContext["expected"], actual: ReturnType<typeof statusFields>) {
    if (!actual || expected.value !== actual.value) return false;
    if (expected.expiresAtMs !== undefined && expected.expiresAtMs !== actual.expiresAtMs) return false;
    if (expected.createdAtMs !== undefined && expected.createdAtMs !== actual.createdAtMs) return false;
    return true;
}

/** Identity follows the updater callback through the exact generated partial proto. */
export class Provenance {
    private callbacks = new WeakMap<object, WriteToken>();
    private updates = new WeakMap<object, WriteToken>();
    private updaterTokens = new WeakMap<object, WriteToken[]>();
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
        if (this.latestLocalToken && this.latestLocalToken !== token) this.supersededTokens.add(token);
        const queue = this.updaterTokens.get(updater) ?? [];
        if (!queue.includes(token)) queue.push(token);
        this.updaterTokens.set(updater, queue);
        this.activeTokens.add(token);
        return token;
    }
    saveStarted(updater: object, proto: unknown): SaveContext | undefined {
        const fields = statusFields(proto);
        const queue = this.updaterTokens.get(updater) ?? [];
        let token: WriteToken | undefined;
        for (let i = queue.length - 1; i >= 0; i--) {
            if (fields?.value === queue[i].target) { token = queue[i]; break; }
        }
        if (!token || !fields || !this.activeTokens.has(token)) return undefined;
        return { token, expected: fields };
    }
    saveSucceeded(updater: object, context: SaveContext | undefined, proto: object) {
        if (!context || !this.activeTokens.has(context.token)) return false;
        this.activeTokens.delete(context.token);
        const queue = this.updaterTokens.get(updater) ?? [];
        this.updaterTokens.set(updater, queue.filter(token => token !== context.token));
        if (this.supersededTokens.has(context.token)) return false;
        if (!matchesStatus(context.expected, statusFields(proto))) return false;
        this.saveAcks.add(proto);
        return true;
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
        this.updaterTokens.set(updater, queue.filter(token => token !== context.token));
    }
    clear() {
        this.callbacks = new WeakMap(); this.updates = new WeakMap();
        this.updaterTokens = new WeakMap(); this.activeTokens.clear(); this.latestLocalToken = null; this.supersededTokens = new WeakSet(); this.saveAcks = new WeakSet();
    }
}
