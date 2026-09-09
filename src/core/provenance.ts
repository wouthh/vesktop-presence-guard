/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { WriteToken } from "./types";
/** Identity follows the updater callback through the exact generated partial proto. */
export class Provenance {
    private callbacks = new WeakMap<object, WriteToken>();
    private updates = new WeakMap<object, WriteToken>();
    register(callback: object, token: WriteToken) { this.callbacks.set(callback, token); }
    generated(callback: object, proto: unknown) {
        const token = this.callbacks.get(callback);
        if (token && proto && typeof proto === "object") this.updates.set(proto, token);
    }
    take(proto: unknown) {
        if (!proto || typeof proto !== "object") return undefined;
        const token = this.updates.get(proto);
        this.updates.delete(proto);
        return token;
    }
    clear() { this.callbacks = new WeakMap(); this.updates = new WeakMap(); }
}
