/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { ActivityObservation } from "./activity";
import type { DisplayObservation } from "./display";

export interface DetectorSnapshot {
    at: number | null;
    sequence: number | null;
    healthy: boolean;
    helperLeaseHealthy: boolean;
    reason: string;
    observation: DisplayObservation | null;
    activity: ActivityObservation | null;
}

function unavailable(reason: string, snapshot?: Record<string, any>): DetectorSnapshot {
    return {
        at: Number.isFinite(snapshot?.at) ? snapshot!.at : null,
        sequence: Number.isInteger(snapshot?.sequence) ? snapshot!.sequence : null,
        healthy: false,
        helperLeaseHealthy: false,
        reason,
        observation: null,
        activity: null
    };
}

/** Validate one helper generation and keep display and activity facts correlated. */
export function validateDetectorSnapshot(input: unknown, now = Date.now(), unavailableReason = "snapshot_unavailable"): DetectorSnapshot {
    if (input === null || input === undefined) return unavailable(unavailableReason);
    if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable("snapshot_schema_unsupported");
    const snapshot = input as Record<string, any>;
    if (snapshot.version !== 2 || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 1 || !Number.isFinite(snapshot.at)) return unavailable("snapshot_schema_unsupported", snapshot);
    if (now < snapshot.at || now - snapshot.at > 10_000) return unavailable("snapshot_stale", snapshot);
    const candidate = snapshot.activity;
    const activityValid = !!candidate && Number.isFinite(candidate.at) && now >= candidate.at && now - candidate.at <= 10_000
        && (candidate.inputOnly === true ? candidate.idleMs === null : Number.isFinite(candidate.idleMs) && candidate.idleMs >= 0)
        && typeof candidate.suspended === "boolean"
        && typeof candidate.provider === "string" && !!candidate.provider && candidate.provider.length <= 512
        && Number.isInteger(candidate.activitySerial) && candidate.activitySerial >= 0
        && Number.isFinite(candidate.activityAt) && candidate.activityAt >= 0 && candidate.activityAt <= candidate.at
        && (candidate.inputOnly === undefined || candidate.inputOnly === true)
        && (candidate.inputOnly !== true || (!candidate.suspended && candidate.activitySerial > 0 && candidate.activityAt > 0 && now - candidate.activityAt <= 10_000));
    const observation = snapshot.observation && typeof snapshot.observation === "object" && !Array.isArray(snapshot.observation)
        && Number.isFinite(snapshot.observation.at) && now >= snapshot.observation.at && now - snapshot.observation.at <= 10_000
        ? snapshot.observation as DisplayObservation
        : null;
    const reason = typeof snapshot.reason === "string" ? snapshot.reason.slice(0, 120) : observation ? "healthy" : "display_observation_unavailable";
    return {
        at: snapshot.at,
        sequence: snapshot.sequence,
        healthy: true,
        helperLeaseHealthy: reason !== "lease_inactive" && reason !== "helper_stopped",
        reason,
        observation,
        activity: activityValid ? candidate as ActivityObservation : null
    };
}
