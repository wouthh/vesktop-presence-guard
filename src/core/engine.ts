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
    private owner: { status: Status; rule: Rule; token: WriteToken } | null = null;
    private latestAppliedWrite: WriteToken | null = null;
    private terminalSaveTokens = new WeakSet<WriteToken>();
    private paused = new Set<Rule>();
    private decisionKey = "";
    private detectorEpoch = -Infinity;
    private manualPending: Status | null = null;
    private confirmedAccount: string | null = null;
    latestDecision = "starting";
    constructor(private adapter: Adapter, private clock: Clock, private options: Options) {}

    get ownership() { return this.owner ? { status: this.owner.status, rule: this.owner.rule } : null; }
    get pausedRules() { return [...this.paused]; }
    get running() { return !this.stopped; }

    private emit(kind: HistoryEvent["kind"], reason: string, source: Source, s: Snapshot, previous = this.previous?.effective ?? "unknown", target = s.effective, saveState?: HistoryEvent["saveState"]) {
        this.latestDecision = reason;
        if (!this.options.observe) return;
        this.adapter.record({ at: this.clock.now(), kind, source, previous, status: target, configured: s.configured, aggregate: s.aggregate, reason, owned: !!this.owner, nativeIdleAttributed: s.nativeIdleAttributed, activity: { ...s.activity }, saveState, display: { ...s.display }, camera: { ...s.camera } });
    }

    private invalidate(keepOwner = false) {
        this.generation++;
        if (this.timer !== undefined) this.clock.clear(this.timer);
        this.timer = undefined;
        this.scheduledRule = null;
        this.pending = null;
        if (!keepOwner) this.owner = null;
        if (!keepOwner) this.latestAppliedWrite = null;
    }

    boundary(reason: string) {
        this.invalidate();
        if (reason === "logout") { this.manualPending = null; this.confirmedAccount = null; }
        this.detectorEpoch = this.clock.now();
        this.emit("boundary", reason, "unknown", this.adapter.read());
    }

    manual(value: Status) {
        const affected = [this.owner?.rule, this.pending?.rule, this.scheduledRule].filter((rule): rule is Rule => !!rule);
        this.invalidate();
        this.manualPending = value === "online" ? null : value;
        if (value === "online") this.paused.clear();
        else { this.paused.add("idle"); for (const rule of affected) this.paused.add(rule); }
        this.decisionKey = "";
        this.emit("boundary", "manual_selection_ownership_revoked", "manual", this.adapter.read(), undefined, value);
        // The caller schedules a fresh sample after Discord processes the action.
    }

    external(source: Source = "unknown") {
        this.paused.add("idle");
        this.paused.add("camera");
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

    saveOutcome(token: WriteToken, state: NonNullable<HistoryEvent["saveState"]>, reason: string) {
        this.emit("save", reason, "plugin", this.adapter.read(), undefined, token.target, state);
        const wasAlreadyTerminal = this.terminalSaveTokens.has(token);
        const failedPendingWrite = this.pending === token;
        const failedOwnedWrite = this.owner?.token === token;
        const failedLatestWrite = this.latestAppliedWrite === token;
        if (["succeeded", "failed", "unavailable"].includes(state)) {
            this.terminalSaveTokens.add(token);
            if (this.latestAppliedWrite === token) this.latestAppliedWrite = null;
        }
        if (state === "failed" && !wasAlreadyTerminal && (failedPendingWrite || failedOwnedWrite || failedLatestWrite)) {
            this.paused.add(token.rule);
            // A delayed save failure may belong to the current owner while a
            // different rule is already writing. Revoke only this token's
            // pending mutation; never cancel unrelated scheduled or in-flight work.
            if (failedPendingWrite) this.invalidate(true);
        }
    }

    stop() {
        this.boundary("plugin_stopped_status_left_unchanged");
        this.stopped = true;
    }

    sample(source: Source = "unknown", token?: WriteToken) {
        if (this.stopped) return;
        const s = this.adapter.read();
        if (s.account && this.confirmedAccount && s.account !== this.confirmedAccount) {
            this.manualPending = null;
            this.boundary("account_changed");
        }
        if (s.account) this.confirmedAccount = s.account;
        // The picker runs before Discord asynchronously loads and applies settings.
        // A non-Online selection blocks acquisition while the old preference is Online.
        if (s.account && this.manualPending !== "unknown" && s.configured === this.manualPending) this.manualPending = null;
        if (!s.connected || !s.account || !s.capable) {
            const becameUncertain = !this.previous || (this.previous.connected && !s.connected) || (this.previous.account && !s.account) || (this.previous.capable && !s.capable);
            if (becameUncertain || this.owner || this.pending || this.timer !== undefined) this.boundary("connection_or_capability_uncertain");
        }
        const ownConfirmation = token !== undefined && token === this.pending && token.generation === this.generation && s.connected && s.capable && s.account && s.configured === token.target;
        if (ownConfirmation) {
            this.latestAppliedWrite = this.terminalSaveTokens.has(token) ? null : token;
            this.owner = token.target === "online" ? null : { status: token.target, rule: token.rule, token };
            this.pending = null;
            this.emit("confirmation", "configured_status_locally_applied_effective_presence_observed_separately", "plugin", s);
        } else if (this.owner && s.configured !== this.owner.status) {
            this.paused.add(this.owner.rule);
            this.invalidate();
            this.emit("skip", "status_conflict_rule_paused", source, s);
        }
        if (!this.previous || s.configured !== this.previous.configured || s.effective !== this.previous.effective || s.aggregate !== this.previous.aggregate) {
            const actualSource = ownConfirmation ? "plugin" : source;
            this.emit("observation", s.configured === "online" && s.effective === "idle" && s.nativeIdle === true ? "configured_online_observed_native_idle" : "status_observed", actualSource, s);
        }
        if (this.previous && JSON.stringify(s.display.facts) !== JSON.stringify(this.previous.display.facts)) {
            this.emit("observation", "display_facts_observed_cause_not_proven", "unknown", s, s.effective);
        }
        if (!this.previous || s.activity.value !== this.previous.activity.value || s.activity.reason !== this.previous.activity.reason || s.nativeIdleAttributed !== this.previous.nativeIdleAttributed) {
            this.emit("observation", s.activity.value === "active" ? "desktop_activity_confirmed" : s.activity.value === "inactive" ? "desktop_inactivity_confirmed" : "desktop_activity_uncertain", "unknown", s, s.effective);
        }
        this.previous = s;
        this.consider();
    }

    private ready(s: Snapshot) {
        return s.connected && s.capable && !!s.account && this.manualPending === null;
    }

    private decide(s: Snapshot, simulation = false): { target?: Status; rule?: Rule; reason: string } {
        if (this.manualPending !== null) return { reason: "manual_selection_awaiting_configured_status" };
        if (!this.ready(s)) return { reason: "non_owned_or_uncertain_status" };
        if (this.owner && s.configured !== this.owner.status) return { reason: "owned_configured_status_changed" };
        const camera = simulation || this.options.camera;
        const idle = simulation || this.options.idle;
        if (camera && !this.paused.has("camera")) {
            const cameraEligible = !!this.owner || (s.configured === "online" && s.effective === "online");
            if (cameraEligible) {
                if (s.camera.at <= this.detectorEpoch) return { reason: "camera_sample_from_previous_epoch" };
                if (fresh(s.camera, this.clock.now()) && s.camera.value === "active") return { target: "dnd", rule: "camera", reason: "confirmed_camera_capture" };
                if (!fresh(s.camera, this.clock.now()) && this.owner?.rule === "camera") return { reason: "camera_unknown_no_release" };
            }
        }
        if (idle && !this.paused.has("idle")) {
            if (!this.owner && s.configured === "online") {
                if (!simulation && !s.nativeIdleHookReady) return { reason: "native_idle_hook_not_ready" };
                const online = s.effective === "online";
                const nativeIdle = s.effective === "idle" && s.nativeIdle === true && s.nativeIdleAttributed;
                if (!online && !nativeIdle) return { reason: s.effective === "idle" ? "effective_idle_not_attributed_to_native" : "effective_presence_uncertain" };
                if (s.activity.at <= this.detectorEpoch) return { reason: "activity_sample_from_previous_epoch" };
                if (fresh(s.activity, this.clock.now()) && s.activity.value === "inactive") return { target: "idle", rule: "idle", reason: "desktop_inactive_for_300_seconds" };
                if (!fresh(s.activity, this.clock.now())) return { reason: "activity_data_missing_or_stale" };
            }
        }
        if (this.owner) {
            const releaseAlreadyInFlight = this.pending?.target === "online" && this.pending.rule === this.owner.rule;
            if (this.owner.rule === "idle") {
                if (fresh(s.activity, this.clock.now()) && s.activity.value === "active" && (!this.paused.has(this.owner.rule) || releaseAlreadyInFlight)) {
                    return { target: "online", rule: "idle", reason: "confirmed_desktop_activity_releasing_owned_idle" };
                }
                if (this.paused.has(this.owner.rule)) return { reason: "owned_rule_paused_after_write_failure" };
                if (!fresh(s.activity, this.clock.now())) return { reason: "activity_data_missing_or_stale_no_release" };
            } else {
                if (fresh(s.display, this.clock.now()) && s.display.value === "active" && s.nativeIdle === false && (!camera || (fresh(s.camera, this.clock.now()) && s.camera.value === "inactive")) && (!this.paused.has(this.owner.rule) || releaseAlreadyInFlight)) {
                    return { target: "online", rule: this.owner.rule, reason: "confirmed_return_releasing_owned_status" };
                }
                if (this.paused.has(this.owner.rule)) return { reason: "owned_rule_paused_after_write_failure" };
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
        const key = JSON.stringify([simulation, d, s.configured, s.effective, s.nativeIdle, s.nativeIdleAttributed, s.activity.value, s.activity.reason, s.display.value, s.display.reason, s.camera.value, s.camera.reason, this.ownership]);
        if (key !== this.decisionKey) {
            this.decisionKey = key;
            this.emit(simulation ? "simulation" : "skip", simulation ? `would_${d.target ?? "skip"}:${d.reason}` : d.reason, "plugin", s, undefined, d.target ?? s.effective);
        }
        if (simulation || this.busy || this.timer !== undefined || !d.target || !d.rule || d.target === s.configured) return;
        const token: WriteToken = { generation: this.generation, target: d.target, rule: d.rule };
        this.scheduledRule = d.rule;
        this.timer = this.clock.set(() => {
            this.timer = undefined;
            this.scheduledRule = null;
            const guard = () => {
                const current = this.adapter.read();
                const next = this.decide(current);
                return !this.stopped && token.generation === this.generation && current.account === s.account && next.target === token.target && next.rule === token.rule && (this.options.idle || this.options.camera);
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
