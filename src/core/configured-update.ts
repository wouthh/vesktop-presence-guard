/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ConfiguredUpdateEvidence {
    hasConfiguredStatus: boolean;
    changed: boolean;
    local?: boolean;
    partial?: boolean;
    wasSaved?: boolean;
    pluginLocalUpdate: boolean;
    correlatedPluginSave: boolean;
    matchedManualSelection: boolean;
}

export interface ManualSelectionEvidence {
    expected: boolean;
    changed: boolean;
    local?: boolean;
    partial?: boolean;
    targetMatches: boolean;
    expiryMatches: boolean;
}

/** Only the expected local status-and-duration update can acknowledge a picker choice. */
export function isManualSelectionUpdate(e: ManualSelectionEvidence) {
    return e.expected && e.changed && e.local === true && e.partial === true && e.targetMatches && e.expiryMatches;
}

/** Discord computes expiry during the immediately following local status update. */
export function matchesManualExpiry(expected: number, actual: unknown) {
    if (typeof actual !== "string" && typeof actual !== "number") return false;
    const parsed = Number(actual);
    return Number.isFinite(parsed) && Math.abs(parsed - expected) <= 2_000;
}

/** A picker choice without a duration is represented by a status-only update. */
export function matchesManualSelectionExpiry(expected: number, hasExpiry: boolean, actual: unknown) {
    return hasExpiry ? matchesManualExpiry(expected, actual) : expected === 0;
}

/** Detect an observable configured-setting mutation without inferring from presence events. */
export function isConfiguredIntervention(e: ConfiguredUpdateEvidence) {
    if (!e.hasConfiguredStatus || !e.changed || e.pluginLocalUpdate || e.correlatedPluginSave || e.matchedManualSelection) return false;
    if (e.local === true) return e.partial === true;
    return e.partial === true || e.local === false && e.wasSaved === true;
}
