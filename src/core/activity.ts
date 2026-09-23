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
    idleMs: number;
    suspended: boolean;
    provider: string;
    activitySerial: number;
    activityAt: number;
}

/**
 * Only Mutter's one-shot user-active watch proves a return. Counter changes
 * still prove five minutes of inactivity, but a reset by itself is Unknown.
 */
export class ActivityDetector {
    private previous: ActivityObservation | null = null;
    private provedSerial: number | null = null;
    private requalifyAt: number | null = null;

    reset() { this.previous = null; this.provedSerial = null; this.requalifyAt = null; }

    observe(o: ActivityObservation | null): Signal {
        const scope = "GNOME system-wide user activity";
        if (!o || !Number.isFinite(o.at) || !Number.isFinite(o.idleMs) || o.idleMs < 0
            || !Number.isInteger(o.activitySerial) || o.activitySerial < 0 || !Number.isFinite(o.activityAt)
            || o.activityAt < 0 || o.activityAt > o.at || typeof o.suspended !== "boolean"
            || typeof o.provider !== "string" || !o.provider || o.provider.length > 512) {
            this.reset(); return UNKNOWN(scope, "activity_provider_unavailable");
        }
        const p = this.previous;
        this.previous = o;
        if (o.suspended) { this.provedSerial = null; this.requalifyAt = o.at; return UNKNOWN(scope, "system_suspended", o.at); }
        if (!p) {
            if (o.activitySerial > 0 && o.activityAt > 0 && o.at - o.activityAt <= MAX_GAP_MS) {
                this.provedSerial = o.activitySerial;
                this.requalifyAt = null;
                return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
            }
            this.provedSerial = null;
            return UNKNOWN(scope, "activity_continuity_starting", o.at);
        }
        if (o.activitySerial > p.activitySerial && o.activityAt >= p.at && o.at - o.activityAt <= MAX_GAP_MS) {
            this.provedSerial = o.activitySerial;
            this.requalifyAt = null;
            return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
        }
        if (o.provider !== p.provider) {
            if (o.activitySerial > 0 && o.activityAt > 0 && o.at - o.activityAt <= MAX_GAP_MS) {
                this.provedSerial = o.activitySerial;
                this.requalifyAt = null;
                return { value: "active", at: o.at, scope, reason: "mutter_user_active_watch_fired" };
            }
            this.provedSerial = null;
            this.requalifyAt = o.at;
            return UNKNOWN(scope, "activity_provider_changed", o.at);
        }
        if (o.at <= p.at || o.at - p.at > MAX_GAP_MS) {
            this.provedSerial = null;
            this.requalifyAt = o.at;
            return UNKNOWN(scope, "activity_continuity_lost", o.at);
        }
        if (o.activitySerial < p.activitySerial || o.idleMs < p.idleMs) {
            this.provedSerial = null;
            this.requalifyAt = o.at;
            return UNKNOWN(scope, "idle_counter_reset_without_activity_event", o.at);
        }
        if (o.idleMs >= IDLE_THRESHOLD_MS) {
            this.provedSerial = null;
            if (this.requalifyAt !== null && o.at - this.requalifyAt < IDLE_THRESHOLD_MS) return UNKNOWN(scope, "activity_boundary_requalifying", o.at);
            return { value: "inactive", at: o.at, scope, reason: "desktop_idle_counter_reached_300s" };
        }
        if (this.provedSerial !== null && o.activitySerial === this.provedSerial) {
            return { value: "active", at: o.at, scope, reason: "recent_mutter_user_active_watch" };
        }
        return UNKNOWN(scope, "awaiting_positive_desktop_activity", o.at);
    }
}
