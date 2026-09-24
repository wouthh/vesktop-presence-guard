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
    private clearingEvents: HistoryEvent[] = [];
    private paused = false;
    constructor(private append: (event: HistoryEvent) => Promise<unknown>, private now: () => number) {}
    get pendingCount() { return this.pending.length; }
    enqueue(event: HistoryEvent) {
        if (this.clearing) this.clearingEvents = retain([...this.clearingEvents, event], this.now());
        else this.pending = retain([...this.pending, event], this.now());
    }
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
            const event = this.pending.shift()!;
            try { await this.append(event); }
            catch (error) {
                this.pending = retain([event, ...this.pending], this.now());
                throw error;
            }
        }
    }
    clear(operation: () => Promise<unknown>): Promise<void> {
        if (this.clearing) return this.clearing;
        this.paused = true;
        this.clearingEvents = [];
        const clearing = (async () => {
            // An already-issued append completes before the native clear. Never
            // replay an older queued event after a successful user clear.
            try {
                await this.draining?.catch(() => undefined);
                await operation();
                const events = this.clearingEvents;
                this.clearing = undefined;
                this.clearingEvents = [];
                this.pending = events;
            } catch (error) {
                const events = this.clearingEvents;
                this.clearing = undefined;
                this.clearingEvents = [];
                this.pending = retain([...this.pending, ...events], this.now());
                throw error;
            } finally {
                this.paused = false;
            }
        })();
        this.clearing = clearing;
        return clearing;
    }
}
