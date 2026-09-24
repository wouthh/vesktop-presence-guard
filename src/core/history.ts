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
const LEGACY_CONTROL_OBSERVATIONS = new Set(["status_observed", "configured_online_observed_native_idle"]);
// Older builds stored these poll-driven decisions in the control partition.
// Reclassify only the known decision vocabulary; requests, mutations, manual
// boundaries, cancellations, confirmations, saves and failures stay protected.
const LEGACY_REPETITIVE_DECISIONS = new Set([
    "automation_paused",
    "no_change_needed",
    "manual_selection_awaiting_configured_status",
    "non_owned_or_uncertain_status",
    "owned_configured_status_changed",
    "camera_sample_from_previous_epoch",
    "camera_unknown_no_release",
    "native_idle_hook_not_ready",
    "effective_idle_not_attributed_to_native",
    "effective_presence_uncertain",
    "activity_sample_from_previous_epoch",
    "activity_data_missing_or_stale",
    "activity_data_missing_or_stale_no_release",
    "owned_rule_paused_after_write_failure",
    "return_not_confirmed"
]);

function importance(event: HistoryEvent) {
    if (event.kind === "skip" && LEGACY_REPETITIVE_DECISIONS.has(event.reason)) return "detector";
    if (event.importance) return event.importance;
    if (event.kind === "observation" && LEGACY_CONTROL_OBSERVATIONS.has(event.reason)) return "control";
    // New engine skips carry an explicit detector/control classification.
    // Older untagged skips remain control unless they match the narrow legacy
    // repetitive-decision allowlist above.
    return event.kind === "observation" || event.kind === "simulation" ? "detector" : "control";
}

function detectorKey(event: HistoryEvent) {
    const bucket = Math.floor(event.at / COALESCE_WINDOW_MS);
    return JSON.stringify([bucket, event.kind, event.source, event.previous, event.status, event.configured, event.aggregate, event.reason, event.owned, event.nativeIdleAttributed, event.activity?.value, event.activity?.reason, event.display.value, event.display.reason, event.display.facts, event.camera.value, event.camera.reason]);
}

function combineDetectorEvents(events: HistoryEvent[]) {
    const output: HistoryEvent[] = [];
    const indexes = new Map<string, number>();
    for (const input of events) {
        const effectiveImportance = importance(input);
        if (effectiveImportance !== "detector") {
            output.push(input.importance === "control" ? input : { ...input, importance: "control" });
            continue;
        }
        const event = input.importance === "detector" ? input : { ...input, importance: "detector" as const };
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
        const previousFirstAt = previous.firstAt ?? previous.at;
        const previousLastAt = previous.lastAt ?? previous.at;
        const eventFirstAt = event.firstAt ?? event.at;
        const eventLastAt = event.lastAt ?? event.at;
        const overlaps = eventFirstAt <= previousLastAt && previousFirstAt <= eventLastAt;
        const repeatCount = overlaps
            ? Math.max(previous.repeatCount ?? 1, event.repeatCount ?? 1)
            : (previous.repeatCount ?? 1) + (event.repeatCount ?? 1);
        output[index] = { ...previous, at: lastAt, repeatCount: Math.min(1_000_000_000, repeatCount), firstAt, lastAt };
    }
    return output;
}

export function retain(events: HistoryEvent[], now: number): HistoryEvent[] {
    const valid = events.filter(e => Number.isFinite(e.at) && e.at <= now && e.at >= now - RETENTION_MS)
        .sort((a, b) => a.at - b.at);
    const controls = valid.filter(e => importance(e) === "control").slice(-MAX_CONTROL_EVENTS).map(e => e.importance === "control" ? e : { ...e, importance: "control" as const });
    const detectors = combineDetectorEvents(valid.filter(e => importance(e) === "detector")).sort((a, b) => a.at - b.at).slice(-MAX_DETECTOR_EVENTS);
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

export async function clearHistoryView(view: HistoryView, clearNative: () => Promise<unknown>, reloadOnFailure: () => Promise<unknown> = async () => {}, now: () => number = Date.now): Promise<void> {
    const before = view.get();
    view.set([]);
    try { await clearNative(); } catch (error) {
        view.set(retain([...before, ...view.get()], now()));
        try { await reloadOnFailure(); } catch { /* Keep bounded in-memory history when storage is unavailable. */ }
        throw error;
    }
}
