/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { DisplayFacts } from "./types";

// Reconstruct the allowlisted facts: never persist monitor/session identifiers.
export function displayFacts(value: unknown): DisplayFacts | undefined {
    if (!value || typeof value !== "object") return;
    const f = value as DisplayFacts;
    if (![0, 1, 2, 3].includes(f.power) || ![f.locked, f.shieldActive, f.suspended, f.idleThresholdReached].every(v => typeof v === "boolean") || !Number.isInteger(f.thresholdMs) || f.thresholdMs < 0 || f.thresholdMs > 0xffffffff * 1000 || !Number.isInteger(f.monitors) || f.monitors < 1 || f.monitors > 256) return;
    return { power: f.power, locked: f.locked, shieldActive: f.shieldActive, suspended: f.suspended, idleThresholdReached: f.idleThresholdReached, thresholdMs: f.thresholdMs, monitors: f.monitors };
}
export function describeDisplayFacts(f?: DisplayFacts): string {
    return f ? `Mutter power ${f.power === 0 ? "on" : `save (${f.power})`}; lock ${f.locked}; shield ${f.shieldActive}; suspend ${f.suspended}; idle threshold ${f.thresholdMs / 1000}s reached ${f.idleThresholdReached}; ${f.monitors} logical monitor(s)` : "Raw display facts unavailable";
}
