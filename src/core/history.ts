/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { HistoryEvent } from "./types";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_EVENTS = 500;
export function retain(events: HistoryEvent[], now: number): HistoryEvent[] {
    return events.filter(e => Number.isFinite(e.at) && e.at <= now && e.at >= now - RETENTION_MS).slice(-MAX_EVENTS);
}

export function mergeHistory(persisted: HistoryEvent[], current: HistoryEvent[], now: number): HistoryEvent[] {
    const seen = new Set<string>();
    const signal = (s: HistoryEvent["display"]) => [s.at, s.value, s.reason, s.scope];
    const events = [...persisted, ...current].filter(e => {
        const key = JSON.stringify([e.at, e.kind, e.source, e.previous, e.status, e.configured, e.aggregate, e.reason, e.owned, signal(e.display), signal(e.camera)]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
    return retain(events, now);
}

type HistoryView = { get(): HistoryEvent[]; set(events: HistoryEvent[]): void };
export async function loadHistoryView(view: HistoryView, readNative: () => Promise<HistoryEvent[]>, current: () => boolean, now: () => number): Promise<void> {
    const history = await readNative();
    if (current()) view.set(mergeHistory(history, view.get(), now()));
}

export async function clearHistoryView(view: HistoryView, clearNative: () => Promise<unknown>, reloadOnFailure: () => Promise<unknown> = async () => {}): Promise<void> {
    const covered = new Set(view.get());
    try { await clearNative(); } catch (error) { await reloadOnFailure(); throw error; }
    view.set(view.get().filter(event => !covered.has(event)));
}
