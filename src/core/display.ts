/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { type Signal,UNKNOWN } from "./types";
export interface DisplayObservation {
    at: number;
    power: number;
    idleMs: number;
    thresholdMs: number;
    locked: boolean;
    suspended: boolean;
    topology: string;
    monitors: number;
    provider: string;
}
export class DisplayDetector {
    private previous: DisplayObservation | null = null;
    private qualifying = false;
    private manualLock = false;
    reset() { this.previous = null; this.qualifying = false; this.manualLock = false; }
    observe(o: DisplayObservation | null): Signal {
        const scope = "GNOME session; inactivity cause inferred";
        if (!o || ![o.at, o.idleMs, o.thresholdMs, o.power, o.monitors].every(Number.isFinite) || typeof o.locked !== "boolean" || typeof o.suspended !== "boolean" || typeof o.topology !== "string" || typeof o.provider !== "string" || o.topology.length > 2048 || o.provider.length > 128 || o.idleMs < 0 || o.monitors < 1 || !o.topology || !o.provider || ![0, 1, 2, 3].includes(o.power)) {
            this.reset(); return UNKNOWN(scope, "display_unavailable");
        }
        const p = this.previous;
        this.previous = o;
        const gap = p && (o.at < p.at || o.at - p.at > 10_000 || o.provider !== p.provider || o.topology !== p.topology || o.thresholdMs !== p.thresholdMs);
        if (o.suspended || gap) {
            this.qualifying = false; this.manualLock = false;
            return UNKNOWN(scope, o.suspended ? "system_suspended" : "display_continuity_lost", o.at);
        }
        if (p && !p.locked && o.locked && (o.thresholdMs <= 0 || o.idleMs < o.thresholdMs)) this.manualLock = true;
        if (o.power === 0 && !o.locked && o.idleMs < 5_000) {
            this.qualifying = false; this.manualLock = false;
            return { value: "active", at: o.at, scope, reason: "display_on_recent_session_activity" };
        }
        if (o.power !== 0 && p?.power === 0 && !this.manualLock && o.thresholdMs > 0 && o.idleMs >= o.thresholdMs && p.idleMs >= Math.max(0, o.thresholdMs - 3_000)) this.qualifying = true;
        if (o.power === 0) this.qualifying = false;
        if (this.qualifying && o.power !== 0 && o.idleMs >= o.thresholdMs && !this.manualLock) return { value: "inactive", at: o.at, scope, reason: "inferred_inactivity_blanking" };
        return UNKNOWN(scope, this.manualLock ? "manual_lock_not_inactivity_proof" : "display_cause_or_return_uncertain", o.at);
    }
}
