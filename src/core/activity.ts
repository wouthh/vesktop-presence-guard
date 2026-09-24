/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Signal, UNKNOWN } from "./types";

export const IDLE_THRESHOLD_MS = 300_000;
const MAX_GAP_MS = 10_000;
export interface ActivityObservation {
    at: number;
    idleMs: number | null;
    suspended: boolean;
    provider: string;
    activitySerial: number;
    activityAt: number;
    /** A fresh input watch invalidated the concurrent counter read. */
    inputOnly?: true;
}

/**
 * Only Mutter's one-shot user-active watch proves a return. Counter changes
 * still prove five minutes of inactivity, but a reset by itself is Unknown.
 */
export class ActivityDetector {
    private previous: ActivityObservation | null = null;
    private provedSerial: number | null = null;
    private provedActivityAt: number | null = null;
    private requalifyAt: number | null = null;
    private unavailable = false;
    private continuityReason: string | null = null;

    get continuityResetReason() { return this.continuityReason; }
    remainingQualificationMs(now: number) {
        const counterRemaining = this.previous?.idleMs === null || this.previous?.idleMs === undefined
            ? null : Math.max(0, IDLE_THRESHOLD_MS - this.previous.idleMs);
        const inputRemaining = this.provedActivityAt === null ? 0 : Math.max(0, IDLE_THRESHOLD_MS - Math.max(0, now - this.provedActivityAt));
        const boundaryRemaining = this.requalifyAt === null ? 0 : Math.max(0, IDLE_THRESHOLD_MS - Math.max(0, now - this.requalifyAt));
        const remaining = Math.max(counterRemaining ?? 0, inputRemaining, boundaryRemaining);
        return counterRemaining === null && this.requalifyAt === null && this.provedActivityAt === null ? null : remaining;
    }

    reset(requireRequalification = false) {
        this.previous = null;
        this.provedSerial = null;
        this.provedActivityAt = null;
        this.requalifyAt = null;
        this.unavailable = requireRequalification;
        this.continuityReason = requireRequalification ? "new_activity_epoch" : null;
    }

    observe(o: ActivityObservation | null, now = o?.at ?? Date.now()): Signal {
        const scope = "GNOME system-wide user activity";
        const commonValid = o !== null && Number.isFinite(o.at) && o.at <= now && now - o.at <= MAX_GAP_MS
            && Number.isInteger(o.activitySerial) && o.activitySerial >= 0 && Number.isFinite(o.activityAt)
            && o.activityAt >= 0 && o.activityAt <= o.at && typeof o.suspended === "boolean"
            && typeof o.provider === "string" && !!o.provider && o.provider.length <= 512;
        if (!o || !commonValid) {
            this.previous = null;
            this.provedSerial = null;
            this.unavailable = true;
            this.continuityReason = "activity_provider_unavailable";
            this.requalifyAt = Number.isFinite(now) ? now : null;
            return UNKNOWN(scope, "activity_provider_unavailable", Number.isFinite(now) ? now : Date.now());
        }
        const p = this.previous;
        if (o.inputOnly === true) {
            const providerChanged = !!p && p.provider !== o.provider;
            if (o.idleMs !== null || o.suspended || o.activitySerial < 1 || o.activityAt < 1
                || now - o.activityAt > MAX_GAP_MS || (p && !providerChanged && o.activitySerial <= p.activitySerial)) {
                this.unavailable = true;
                this.provedSerial = null;
                this.provedActivityAt = null;
                this.continuityReason = "invalid_or_stale_input_pulse";
                this.requalifyAt = o.at;
                return UNKNOWN(scope, "invalid_or_stale_input_pulse", o.at);
            }
            if (providerChanged) this.previous = null;
            this.provedSerial = o.activitySerial;
            this.provedActivityAt = o.activityAt;
            this.requalifyAt = null;
            this.unavailable = false;
            this.continuityReason = null;
            return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired_counter_refresh_pending" };
        }
        if (!Number.isFinite(o.idleMs) || o.idleMs === null || o.idleMs < 0) {
            this.previous = null;
            this.provedSerial = null;
            this.provedActivityAt = null;
            this.unavailable = true;
            this.continuityReason = "activity_counter_unavailable";
            this.requalifyAt = o.at;
            return UNKNOWN(scope, "activity_counter_unavailable", o.at);
        }
        this.previous = o;
        if (o.suspended) { this.provedSerial = null; this.provedActivityAt = null; this.requalifyAt = o.at; this.continuityReason = "system_suspended"; this.unavailable = false; return UNKNOWN(scope, "system_suspended", o.at); }
        if (this.unavailable) {
            this.unavailable = false;
            this.provedSerial = null;
            this.requalifyAt = o.at;
            this.continuityReason = "activity_recovery_boundary";
            if (o.activitySerial > 0 && o.activityAt > 0 && o.at - o.activityAt <= MAX_GAP_MS) {
                this.provedSerial = o.activitySerial;
                this.provedActivityAt = o.activityAt;
                this.requalifyAt = null;
                this.continuityReason = null;
                return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
            }
            return UNKNOWN(scope, "activity_recovery_boundary", o.at);
        }
        if (!p) {
            if (o.activitySerial > 0 && o.activityAt > 0 && o.at - o.activityAt <= MAX_GAP_MS) {
                this.provedSerial = o.activitySerial;
                this.provedActivityAt = o.activityAt;
                this.requalifyAt = null;
                this.continuityReason = null;
                return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
            }
            this.provedSerial = null;
            this.provedActivityAt = null;
            this.requalifyAt = o.at;
            this.continuityReason = "activity_continuity_starting";
            return UNKNOWN(scope, "activity_continuity_starting", o.at);
        }
        if (o.activitySerial > p.activitySerial && o.activityAt >= p.at && o.at - o.activityAt <= MAX_GAP_MS) {
            this.provedSerial = o.activitySerial;
            this.provedActivityAt = o.activityAt;
            this.requalifyAt = null;
            this.continuityReason = null;
            return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
        }
        if (o.provider !== p.provider) {
            if (o.activitySerial > 0 && o.activityAt > 0 && o.at - o.activityAt <= MAX_GAP_MS) {
                this.provedSerial = o.activitySerial;
                this.provedActivityAt = o.activityAt;
                this.requalifyAt = null;
                this.continuityReason = null;
                return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
            }
            this.provedSerial = null;
            this.provedActivityAt = null;
            this.requalifyAt = o.at;
            this.continuityReason = "activity_provider_changed";
            return UNKNOWN(scope, "activity_provider_changed", o.at);
        }
        if (o.at < p.at || o.at - p.at > MAX_GAP_MS) {
            this.provedSerial = null;
            this.provedActivityAt = null;
            this.requalifyAt = o.at;
            this.continuityReason = "activity_continuity_lost";
            return UNKNOWN(scope, "activity_continuity_lost", o.at);
        }
        if (o.activitySerial < p.activitySerial || p.idleMs === null || o.idleMs < p.idleMs) {
            this.provedSerial = null;
            this.provedActivityAt = null;
            this.requalifyAt = o.at;
            this.continuityReason = "idle_counter_reset_without_activity_event";
            return UNKNOWN(scope, "idle_counter_reset_without_activity_event", o.at);
        }
        if (o.idleMs >= IDLE_THRESHOLD_MS) {
            this.provedSerial = null;
            this.provedActivityAt = null;
            if (this.requalifyAt !== null && o.at - this.requalifyAt < IDLE_THRESHOLD_MS) {
                this.continuityReason = "activity_boundary_requalifying";
                return UNKNOWN(scope, "activity_boundary_requalifying", o.at);
            }
            this.requalifyAt = null;
            this.continuityReason = null;
            return { value: "inactive", at: o.at, scope, reason: "desktop_idle_counter_reached_300s" };
        }
        if (this.provedSerial !== null && o.activitySerial === this.provedSerial) {
            this.provedActivityAt = o.activityAt;
            return { value: "active", at: o.at, scope, reason: "recent_mutter_user_active_watch" };
        }
        this.continuityReason ??= "awaiting_positive_desktop_activity";
        return UNKNOWN(scope, "awaiting_positive_desktop_activity", o.at);
    }
}
