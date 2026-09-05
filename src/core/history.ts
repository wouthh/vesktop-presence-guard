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

export async function clearHistoryView(view: { get(): HistoryEvent[]; set(events: HistoryEvent[]): void }, clearNative: () => Promise<unknown>): Promise<void> {
    const covered = new Set(view.get());
    await clearNative();
    view.set(view.get().filter(event => !covered.has(event)));
}
