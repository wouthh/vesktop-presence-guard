/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { type Adapter, type Clock, fresh, type HistoryEvent, type Options, type Rule, type Snapshot, type Source, type Status, type WriteToken } from "./types";

export class PresenceEngine {
    private generation = 0;
    private timer: unknown;
    private scheduledRule: Rule | null = null;
    private busy = false;
    private stopped = false;
    private pending: WriteToken | null = null;
    private previous: Snapshot | null = null;
    private owner: { status: Status; rule: Rule } | null = null;
    private paused = new Set<Rule>();
    private decisionKey = "";
    private detectorEpoch = -Infinity;
    private manualPending: Status | null = null;
    latestDecision = "starting";
    constructor(private adapter: Adapter, private clock: Clock, private options: Options) {}

    get ownership() { return this.owner ? { ...this.owner } : null; }
    get pausedRules() { return [...this.paused]; }
    get running() { return !this.stopped; }

    private emit(kind: HistoryEvent["kind"], reason: string, source: Source, s: Snapshot, previous = this.previous?.effective ?? "unknown", target = s.effective) {
        this.latestDecision = reason;
        if (!this.options.observe) return;
        this.adapter.record({ at: this.clock.now(), kind, source, previous, status: target, configured: s.configured, aggregate: s.aggregate, reason, owned: !!this.owner, display: { ...s.display }, camera: { ...s.camera } });
    }

    private invalidate(keepOwner = false) {
        this.generation++;
        if (this.timer !== undefined) this.clock.clear(this.timer);
        this.timer = undefined;
        this.scheduledRule = null;
        this.pending = null;
        if (!keepOwner) this.owner = null;
    }

    boundary(reason: string) {
        this.invalidate();
        this.manualPending = null;
        this.detectorEpoch = this.clock.now();
        this.emit("boundary", reason, "unknown", this.adapter.read());
    }

    manual(value: Status) {
        this.invalidate();
        this.manualPending = value === "online" ? null : value;
        if (value === "online") this.paused.clear();
        this.decisionKey = "";
        this.emit("boundary", "manual_selection_ownership_revoked", "manual", this.adapter.read(), undefined, value);
        // The caller schedules a fresh sample after Discord processes the action.
    }

    external(source: Source = "unknown") {
        if (this.owner) this.paused.add(this.owner.rule);
        if (this.pending) this.paused.add(this.pending.rule);
        if (this.scheduledRule) this.paused.add(this.scheduledRule);
        this.invalidate();
        this.emit("boundary", "unattributed_status_write", source, this.adapter.read());
    }

    configure(next: Options) {
        const disabling = (this.options.idle && !next.idle) || (this.options.camera && !next.camera);
        if (disabling) {
            const disabled = (rule: Rule) => rule === "idle" ? !next.idle : !next.camera;
            if (this.owner && disabled(this.owner.rule)) {
                this.invalidate();
                this.emit("boundary", "rule_disabled_status_left_unchanged", "plugin", this.adapter.read());
            } else if (this.pending && disabled(this.pending.rule)) {
                this.invalidate(true);
                this.emit("skip", "pending_rule_disabled_owner_retained_if_matching", "plugin", this.adapter.read());
            } else if (this.timer !== undefined) {
                this.clock.clear(this.timer); this.timer = undefined; this.scheduledRule = null; this.generation++;
            }
        }
        this.options = { ...next };
        this.decisionKey = "";
        this.sample();
    }

    resume() {
        this.paused.clear();
        this.decisionKey = "";
        this.sample();
    }

    stop() {
        this.boundary("plugin_stopped_status_left_unchanged");
        this.stopped = true;
    }

    sample(source: Source = "unknown", token?: WriteToken) {
        if (this.stopped) return;
        const s = this.adapter.read();
        if (this.previous && s.account !== this.previous.account) this.boundary("account_changed");
        // The picker runs before Discord asynchronously loads and applies settings.
        // A non-Online selection blocks acquisition while the old preference is Online.
        if (this.manualPending !== "unknown" && s.configured === this.manualPending) this.manualPending = null;
        if (!s.connected || !s.account || !s.capable) {
            if (this.owner || this.pending || this.timer !== undefined) this.boundary("connection_or_capability_uncertain");
        }
        const ownConfirmation = token !== undefined && token === this.pending && token.generation === this.generation && s.connected && s.capable && s.account && s.configured === token.target && s.effective === token.target;
        if (ownConfirmation) {
            this.owner = token.target === "online" ? null : { status: token.target, rule: token.rule };
            this.pending = null;
            this.emit("confirmation", "confirmed_local_update_server_save_not_proven", "plugin", s);
        } else if (this.owner && (s.configured !== this.owner.status || s.effective !== this.owner.status)) {
            this.paused.add(this.owner.rule);
            this.invalidate();
            this.emit("skip", "status_conflict_rule_paused", source, s);
        }
        if (!this.previous || s.configured !== this.previous.configured || s.effective !== this.previous.effective || s.aggregate !== this.previous.aggregate) {
            const actualSource = ownConfirmation ? "plugin" : source;
            this.emit("observation", s.configured === "online" && s.effective === "idle" && s.nativeIdle === true ? "configured_online_observed_native_idle" : "status_observed", actualSource, s);
        }
        this.previous = s;
        this.consider();
    }

    private eligible(s: Snapshot) {
        if (!s.connected || !s.capable || !s.account || this.manualPending !== null) return false;
        if (this.owner) return s.effective === this.owner.status && s.configured === this.owner.status;
        return s.configured === "online" && s.effective === "online";
    }

    private decide(s: Snapshot, simulation = false): { target?: Status; rule?: Rule; reason: string } {
        if (this.manualPending !== null) return { reason: "manual_selection_awaiting_configured_status" };
        if (!this.eligible(s)) return { reason: "non_owned_or_uncertain_status" };
        const camera = simulation || this.options.camera;
        const idle = simulation || this.options.idle;
        if (camera && !this.paused.has("camera")) {
            if (s.camera.at <= this.detectorEpoch) return { reason: "camera_sample_from_previous_epoch" };
            if (fresh(s.camera, this.clock.now()) && s.camera.value === "active") return { target: "dnd", rule: "camera", reason: "confirmed_camera_capture" };
            if (!fresh(s.camera, this.clock.now()) && this.owner?.rule === "camera") return { reason: "camera_unknown_no_release" };
        }
        if (idle && !this.paused.has("idle")) {
            if (s.display.at <= this.detectorEpoch) return { reason: "display_sample_from_previous_epoch" };
            if (fresh(s.display, this.clock.now()) && s.display.value === "inactive") return { target: "idle", rule: "idle", reason: "inferred_inactivity_blanking" };
            if (!fresh(s.display, this.clock.now())) return { reason: "display_unknown_no_release" };
        }
        if (this.owner) {
            if (fresh(s.display, this.clock.now()) && s.display.value === "active" && s.nativeIdle === false && (!camera || (fresh(s.camera, this.clock.now()) && s.camera.value === "inactive"))) {
                return { target: "online", rule: this.owner.rule, reason: "confirmed_return_releasing_owned_status" };
            }
            return { reason: "return_not_confirmed" };
        }
        return { reason: this.paused.size ? "automation_paused" : "no_change_needed" };
    }

    private consider() {
        if (this.stopped) return;
        const s = this.adapter.read();
        const simulation = !this.options.idle && !this.options.camera;
        const d = this.decide(s, simulation);
        const key = JSON.stringify([simulation, d, s.configured, s.effective, s.display.value, s.display.reason, s.camera.value, s.camera.reason, this.ownership]);
        if (key !== this.decisionKey) {
            this.decisionKey = key;
            this.emit(simulation ? "simulation" : "skip", simulation ? `would_${d.target ?? "skip"}:${d.reason}` : d.reason, "plugin", s, undefined, d.target ?? s.effective);
        }
        if (simulation || this.busy || this.timer !== undefined || !d.target || !d.rule || d.target === s.effective) return;
        const token: WriteToken = { generation: this.generation, target: d.target, rule: d.rule };
        this.scheduledRule = d.rule;
        this.timer = this.clock.set(() => {
            this.timer = undefined;
            this.scheduledRule = null;
            const guard = () => {
                const current = this.adapter.read();
                const next = this.decide(current);
                return !this.stopped && token.generation === this.generation && current.account === s.account && this.eligible(current) && next.target === token.target && next.rule === token.rule && (this.options.idle || this.options.camera);
            };
            if (!guard()) { this.emit("skip", "pending_decision_invalidated", "plugin", this.adapter.read()); return; }
            this.busy = true;
            this.pending = token;
            this.emit("request", d.reason, "plugin", this.adapter.read(), undefined, token.target);
            void this.adapter.write(token, guard).then(() => {
                if (token.generation === this.generation && this.pending === token) {
                    this.paused.add(token.rule);
                    this.invalidate();
                    this.emit("error", "write_not_locally_confirmed_rule_paused", "plugin", this.adapter.read());
                }
            }).catch(() => {
                if (token.generation === this.generation) {
                    this.paused.add(token.rule);
                    this.invalidate();
                    this.emit("error", "write_failed_rule_paused", "plugin", this.adapter.read());
                }
            }).finally(() => { this.busy = false; this.consider(); });
        }, 2_000);
    }
}
