/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { retain } from "./history";
import type { HistoryEvent } from "./types";

// Failed events remain in the same bounded retention window as displayed history.
// Retrying is driven by new events or the plugin's existing reconciliation poll.
export class HistoryWriter {
    private pending: HistoryEvent[] = [];
    private draining?: Promise<void>;
    private clearing?: Promise<void>;
    private paused = false;
    constructor(private append: (event: HistoryEvent) => Promise<unknown>, private now: () => number) {}
    get pendingCount() { return this.pending.length; }
    enqueue(event: HistoryEvent) { this.pending = retain([...this.pending, event], this.now()); }
    flush(): Promise<void> {
        if (this.clearing) return this.clearing.then(() => this.flush());
        if (this.draining) return this.draining;
        this.pending = retain(this.pending, this.now());
        if (!this.pending.length) return Promise.resolve();
        this.draining = this.drain().finally(() => { this.draining = undefined; });
        return this.draining;
    }
    private async drain() {
        while (!this.paused && this.pending.length) {
            const event = this.pending[0];
            await this.append(event);
            this.pending = this.pending.filter(candidate => candidate !== event);
        }
    }
    clear(operation: () => Promise<unknown>): Promise<void> {
        if (this.clearing) return this.clearing;
        const covered = new Set(this.pending);
        this.paused = true;
        this.clearing = (async () => {
            // An already-issued append completes before the native clear. Never
            // replay an older queued event after a successful user clear.
            await this.draining?.catch(() => undefined);
            await operation();
            this.pending = this.pending.filter(event => !covered.has(event));
        })().finally(() => { this.paused = false; this.clearing = undefined; });
        return this.clearing;
    }
}
