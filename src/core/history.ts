/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { HistoryEvent } from "./types";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_EVENTS = 500;
export const MAX_CONTROL_EVENTS = 400;
export const MAX_DETECTOR_EVENTS = 100;
const COALESCE_WINDOW_MS = 15 * 60 * 1_000;

function importance(event: HistoryEvent) {
    return event.importance ?? (event.kind === "observation" || event.kind === "simulation" ? "detector" : "control");
}

function detectorKey(event: HistoryEvent) {
    const bucket = Math.floor(event.at / COALESCE_WINDOW_MS);
    return JSON.stringify([bucket, event.kind, event.source, event.previous, event.status, event.configured, event.aggregate, event.reason, event.owned, event.nativeIdleAttributed, event.activity?.value, event.activity?.reason, event.display.value, event.display.reason, event.display.facts, event.camera.value, event.camera.reason]);
}

function combineDetectorEvents(events: HistoryEvent[]) {
    const output: HistoryEvent[] = [];
    const indexes = new Map<string, number>();
    for (const input of events) {
        if (importance(input) !== "detector") {
            output.push(input.importance ? input : { ...input, importance: "control" });
            continue;
        }
        const event = input.importance ? input : { ...input, importance: "detector" as const };
        const key = detectorKey(event);
        const index = indexes.get(key);
        if (index === undefined) {
            indexes.set(key, output.length);
            output.push({ ...event, repeatCount: Math.max(1, event.repeatCount ?? 1), firstAt: event.firstAt ?? event.at, lastAt: event.lastAt ?? event.at });
            continue;
        }
        const previous = output[index];
        const firstAt = Math.min(previous.firstAt ?? previous.at, event.firstAt ?? event.at);
        const lastAt = Math.max(previous.lastAt ?? previous.at, event.lastAt ?? event.at);
        output[index] = { ...previous, at: lastAt, repeatCount: Math.min(1_000_000_000, (previous.repeatCount ?? 1) + (event.repeatCount ?? 1)), firstAt, lastAt };
    }
    return output;
}

export function retain(events: HistoryEvent[], now: number): HistoryEvent[] {
    const valid = events.filter(e => Number.isFinite(e.at) && e.at <= now && e.at >= now - RETENTION_MS)
        .sort((a, b) => a.at - b.at);
    const controls = valid.filter(e => importance(e) === "control").slice(-MAX_CONTROL_EVENTS);
    const detectors = combineDetectorEvents(valid.filter(e => importance(e) === "detector")).slice(-MAX_DETECTOR_EVENTS);
    return [...controls, ...detectors].sort((a, b) => a.at - b.at).slice(-MAX_EVENTS);
}

export function mergeHistory(persisted: HistoryEvent[], current: HistoryEvent[], now: number): HistoryEvent[] {
    const seen = new Set<string>();
    const signal = (s: HistoryEvent["activity"]) => s && [s.at, s.value, s.reason, s.scope, s.facts];
    const events = [...persisted, ...current].filter(e => {
        const key = JSON.stringify([e.at, e.kind, e.source, e.previous, e.status, e.configured, e.aggregate, e.reason, e.owned, e.importance, e.repeatCount, e.firstAt, e.lastAt, e.nativeIdleAttributed, signal(e.activity), signal(e.display), signal(e.camera)]);
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
