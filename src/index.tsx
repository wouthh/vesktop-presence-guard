/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCode, findByProps, findModuleId, findStoreLazy, wreq } from "@webpack";
import { Button, FluxDispatcher, Forms, Modal, React, UserSettingsProtoStore, UserStore, useState } from "@webpack/common";

import { BUILD_INFO } from "./buildInfo";
import { ActivityDetector, type ActivityObservation } from "./core/activity";
import { cameraSnapshot, PipeWireDetector } from "./core/camera";
import { isConfiguredIntervention, isManualSelectionUpdate, matchesManualSelectionExpiry } from "./core/configured-update";
import { DisplayDetector } from "./core/display";
import { describeDisplayFacts } from "./core/displayFacts";
import { PresenceEngine } from "./core/engine";
import { clearHistoryView, loadHistoryView, retain } from "./core/history";
import { HistoryWriter } from "./core/historyWriter";
import { statusMutator } from "./core/mutator";
import { isNativeAutomaticIdle } from "./core/native-idle";
import { PersistenceHealth } from "./core/persistenceHealth";
import { Provenance } from "./core/provenance";
import { simulate } from "./core/simulation";
import { configuredStatusSignature, parseStatusProto } from "./core/statusProto";
import { CameraTracks } from "./core/tracks";
import { fresh, HistoryEvent, Options, Snapshot, status, UNKNOWN, WriteToken } from "./core/types";
import { actionPatch, cameraPatch, nativeIdlePatch, protoPatch, saveLifecyclePatch, selectionPatch } from "./patches";

const Native = VencordNative.pluginHelpers.PresenceGuard as PluginNative<typeof import("./native")>;
const Configured = getUserSettingLazy<string>("status", "status")!;
const ConfiguredExpires = getUserSettingLazy<unknown>("status", "statusExpiresAtMs");
const ConfiguredCreated = getUserSettingLazy<unknown>("status", "statusCreatedAtMs");
const SelfPresence = findStoreLazy("SelfPresenceStore");
const AggregatePresence = findStoreLazy("PresenceStore");
const Gateway = findStoreLazy("GatewayConnectionStore");
const Idle = findStoreLazy("IdleStore");
const Voice = findStoreLazy("RTCConnectionStore");
const provenance = new Provenance();
const persistenceHealth = new PersistenceHealth();
const historyWriter = new HistoryWriter(event => Native.appendHistory(event), Date.now);
const activityDetector = new ActivityDetector();
const displayDetector = new DisplayDetector();
const pipewireDetector = new PipeWireDetector();
const tracks = new CameraTracks(() => { void poll(); });
const subscriptions: [string, (event: any) => void][] = [];
let engine: PresenceEngine | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let polling = false;
let lifecycle = 0;
let statusHooks = false;
let manualHook = false;
const manualActions = new WeakSet<object>();
let expectedManualStatus: { target: string; expiresAt: number; until: number } | null = null;
let cameraHook = false;
let cameraContinuity = true;
let connectionFresh = false;
let patchError = "starting";
let updater: any;
let nativeIdleHook = false;
let nativeIdleReconcile: (() => void) | undefined;
let nativeIdlePendingUntil = 0;
let nativeIdleAttributed = false;
let saveHooks = false;
let saveState = "unavailable";
let configuredSignature: string | null = null;
let configuredSignatureHealth = "starting";
let pluginActive = false;
let connectionStates: any;
let delay: number;
let events: HistoryEvent[] = [];
let historyGeneration = 0;
let display = UNKNOWN("GNOME");
let activity = UNKNOWN("GNOME system-wide input");
let pwCamera = UNKNOWN("PipeWire");
let localCamera = UNKNOWN("Vesktop");
let helperSnapshotSequence: number | null = null;
let helperSnapshotAgeMs: number | null = null;
let helperSnapshotHealth = "starting";
let activityIdleMs: number | null = null;
let activitySampleAgeMs: number | null = null;
let activityContinuityReason: string | null = null;
let idleQualificationRemainingMs: number | null = null;
const changes = new Set<() => void>();
const notify = () => changes.forEach(fn => fn());
const historyView = { get: () => events, set: (value: HistoryEvent[]) => { events = value; notify(); } };
function loadHistory() {
    const epoch = lifecycle, generation = historyGeneration;
    return loadHistoryView(historyView, () => persistenceHealth.run("history_read", () => Native.readHistory()), () => epoch === lifecycle && generation === historyGeneration, Date.now);
}
const settings = definePluginSettings({
    observe: { type: OptionType.BOOLEAN, description: "Keep bounded local own-status history", default: true, onChange: () => configure() },
    idle: { type: OptionType.BOOLEAN, description: "Set configured Idle after five minutes of desktop inactivity and restore Online on input", default: false, onChange: () => configure() },
    camera: { type: OptionType.BOOLEAN, description: "Automatic DND on confirmed webcam capture (partial coverage)", default: false, onChange: () => configure() }
});
function options(): Options { return { observe: settings.store.observe, idle: settings.store.idle, camera: settings.store.camera }; }
function currentConfiguredSignature() {
    try {
        const signature = configuredStatusSignature(Configured.getSetting(), ConfiguredExpires?.getSetting?.(), ConfiguredCreated?.getSetting?.());
        configuredSignatureHealth = signature === null ? "configured_status_or_duration_shape_unavailable" : "supported";
        return signature;
    } catch { configuredSignatureHealth = "configured_status_signature_read_failed"; return null; }
}
function read(): Snapshot {
    try {
        const account = UserStore.getCurrentUser()?.id ?? null;
        const nativeIdle = typeof Idle.isIdle() === "boolean" ? Idle.isIdle() : null;
        return { account, connected: connectionFresh && Gateway.isConnected() && Gateway.getSocket()?.connectionState === connectionStates?.SESSION_ESTABLISHED, capable: statusHooks, nativeIdleHookReady: nativeIdleHook, configured: status(Configured.getSetting()), effective: status(SelfPresence.getStatus()), aggregate: account ? status(AggregatePresence.getStatus(account, null, "unknown")) : "unknown", nativeIdle, nativeIdleAttributed: nativeIdle === true && nativeIdleAttributed, activity, display, camera: cameraSnapshot(pwCamera, localCamera, Date.now(), cameraContinuity) };
    } catch { return { account: null, connected: false, capable: false, nativeIdleHookReady: false, configured: "unknown", effective: "unknown", aggregate: "unknown", nativeIdle: null, nativeIdleAttributed: false, activity, display, camera: UNKNOWN("Partial", "client_stores_unavailable") }; }
}
function record(event: HistoryEvent) {
    events = retain([...events, event], Date.now());
    historyWriter.enqueue(event);
    void persistPending();
    notify();
}
function persistPending() { return persistenceHealth.run("history_write", () => historyWriter.flush()).then(notify, notify); }
function configure() { engine?.configure(options()); nativeIdleReconcile?.(); notify(); }
function validateHooks() {
    try {
        if (!manualHook) {
            const id = findModuleId(/let\{status:\w+,currentStatus:\w+,description:/);
            if (id != null) wreq(id);
        }
        const action = findByCode("nextStatus:", "statusCreatedAtMs");
        updater = findByProps("updateAsync", "markDirty");
        saveHooks = typeof updater?.markDirty === "function" && updater.markDirty.toString().includes("saveQueued(") && typeof updater?.persistChanges === "function" && updater.persistChanges.toString().includes("saveStarted(") && updater.persistChanges.toString().includes("saveSucceeded(") && updater.persistChanges.toString().includes("saveFailed(");
        connectionStates = findByProps("SESSION_ESTABLISHED", "RESUMING");
        delay = findByProps("INFREQUENT_USER_ACTION", "AUTOMATED")?.INFREQUENT_USER_ACTION;
        const conflict = ["CustomIdle", "AutoDNDWhilePlaying"].some(name => Vencord.Settings.plugins[name]?.enabled);
        const currentSignature = currentConfiguredSignature();
        if (configuredSignature === null && currentSignature !== null) configuredSignature = currentSignature;
        const signatureReady = currentSignature !== null;
        statusHooks = connectionStates?.SESSION_ESTABLISHED !== undefined && manualHook && typeof action === "function" && action.toString().includes(".statusAction(") && typeof updater?.updateAsync === "function" && updater.updateAsync.toString().includes(".generatedUpdate(") && Number.isFinite(delay) && UserSettingsProtoStore.hasLoaded(1) && signatureReady && !conflict;
        patchError = conflict ? "conflicting_status_plugin_enabled" : !signatureReady ? configuredSignatureHealth : !statusHooks ? "required_status_hooks_unavailable" : settings.store.idle && !nativeIdleHook ? "native_idle_hook_not_ready" : "none";
    } catch { statusHooks = false; patchError = "required_status_hooks_unavailable"; }
}
async function write(token: WriteToken, guard: () => boolean) {
    const callback = statusMutator(token.target, guard);
    provenance.register(callback, token);
    await updater.updateAsync("status", callback, delay);
    // Flux confirmation is queued behind the synchronous store update, ahead of this continuation.
    await Promise.resolve();
}
function subscribe(type: string, fn: (event: any) => void) { FluxDispatcher.subscribe(type as any, fn); subscriptions.push([type, fn]); }
function statusUpdate(event: any) {
    const proto = event.settings?.proto;
    const parsed = parseStatusProto(proto);
    if (!parsed.mentionsStatus) return;
    if (parsed.shape === "unsupported") {
        configuredSignatureHealth = "configured_status_proto_shape_unsupported";
        statusHooks = false;
        patchError = configuredSignatureHealth;
        provenance.clear(); saveState = "unavailable";
        engine?.external("unknown");
        notify();
        return;
    }
    const { hasStatus } = parsed;
    const { hasDuration } = parsed;
    if (!hasStatus && !hasDuration) return;
    const token = provenance.take(proto);
    const ownSaveEcho = provenance.takeSaveAck(proto);
    const nextSignature = currentConfiguredSignature();
    const changed = configuredSignature !== null && nextSignature !== null && configuredSignature !== nextSignature;
    configuredSignature = nextSignature;
    const expected = expectedManualStatus;
    const matchesManual = isManualSelectionUpdate({
        expected: expected !== null && expected.until >= Date.now(), changed, local: event.local, partial: event.partial,
        targetMatches: expected !== null && hasStatus && parsed.configured === expected.target && status(Configured.getSetting()) === expected.target,
        expiryMatches: expected !== null && matchesManualSelectionExpiry(expected.expiresAt, parsed.hasExpiresAtMs, parsed.expiresAtMs)
    });
    if (matchesManual) expectedManualStatus = null;
    // Full user-settings snapshots and presence/session events are not manual
    // selections. Only a changed configured-status proto is an intervention.
    const observableMutation = isConfiguredIntervention({ hasConfiguredStatus: true, changed, local: event.local, partial: event.partial, wasSaved: event.wasSaved, pluginLocalUpdate: !!token, correlatedPluginSave: ownSaveEcho, matchedManualSelection: matchesManual });
    if (!token && !ownSaveEcho && observableMutation) {
        provenance.clear(); saveState = "unavailable";
        engine?.external(event.local === false ? "external" : "unknown");
    }
    if (token && !saveHooks) { saveState = "unavailable"; engine?.saveOutcome(token, "unavailable", "save_lifecycle_hooks_unavailable"); }
    queueMicrotask(() => engine?.sample(token || ownSaveEcho ? "plugin" : event.local === false ? "external" : "unknown", token));
}
async function poll() {
    if (polling || !engine?.running) return;
    polling = true;
    const epoch = lifecycle;
    try {
        validateHooks();
        void persistPending();
        await Native.lease(true);
        const [detectors, camera] = await Promise.all([Native.detectorSnapshot(), Native.pipeWireSnapshot()]);
        if (epoch !== lifecycle || !engine?.running) return;
        const sampledAt = Date.now();
        helperSnapshotSequence = Number.isInteger(detectors?.sequence) ? detectors.sequence : null;
        helperSnapshotAgeMs = typeof detectors?.at === "number" && Number.isFinite(detectors.at) ? Math.max(0, sampledAt - detectors.at) : null;
        helperSnapshotHealth = typeof detectors?.reason === "string" ? detectors.reason : "snapshot_unavailable";
        activityIdleMs = typeof detectors?.activity?.idleMs === "number" ? detectors.activity.idleMs : null;
        activitySampleAgeMs = typeof detectors?.activity?.at === "number" && Number.isFinite(detectors.activity.at) ? Math.max(0, sampledAt - detectors.activity.at) : null;
        display = displayDetector.observe(detectors?.observation ?? null);
        activity = activityDetector.observe((detectors?.activity ?? null) as ActivityObservation | null, sampledAt);
        activityContinuityReason = activityDetector.continuityResetReason;
        idleQualificationRemainingMs = activityDetector.remainingQualificationMs(sampledAt);
        nativeIdleReconcile?.();
        pwCamera = camera === null ? UNKNOWN("PipeWire", "pipewire_unavailable", Date.now()) : pipewireDetector.parse(camera, Date.now());
        tracks.prune();
        localCamera = !cameraHook || !cameraContinuity ? UNKNOWN("Vesktop", "camera_hook_or_continuity_unavailable", Date.now()) : { value: tracks.live ? "active" : tracks.size ? "unknown" : "inactive", at: Date.now(), scope: "Vesktop observed camera acquisitions", reason: tracks.size ? "camera_track_live_muted_or_disabled" : "no_observed_live_camera_track" };
        engine.sample();
        const s = read();
        await persistenceHealth.diagnostics(() => Native.diagnostics({ commit: BUILD_INFO.commit, enabled: true, idle: settings.store.idle, camera: settings.store.camera, owned: !!engine?.ownership, configured: s.configured, effective: s.effective, aggregate: s.aggregate, decision: engine?.latestDecision, mode: mode(), displayReason: display.reason, activityReason: activity.reason, activityValue: activity.value, activityIdleMs, idleRemainingMs: idleQualificationRemainingMs, activitySampleAgeMs, activityContinuityReason, helperSnapshotSequence, helperSnapshotAgeMs, helperSnapshotHealth, helperLeaseHealthy: detectors?.helperLeaseHealthy === true, pendingWritePhase: engine?.pendingPhase, pausedRules: engine?.pausedDetails, configuredSignatureHealth, nativeIdleAttributed: s.nativeIdleAttributed, saveState, saveHooks, statusHooks, nativeIdleHook, cameraHook, panelMounted: changes.size > 0, voiceConnected: !!Voice.getChannelId(), localCameraLive: tracks.size > 0, patchError, storageHealth: persistenceHealth.summary }));
        notify();
    } catch { if (epoch === lifecycle) { display = UNKNOWN("GNOME", "native_poll_failed"); activity = UNKNOWN("GNOME system-wide input", "native_poll_failed", Date.now()); pwCamera = UNKNOWN("PipeWire", "native_poll_failed"); helperSnapshotHealth = "native_poll_failed"; helperSnapshotSequence = null; helperSnapshotAgeMs = null; activityIdleMs = null; activitySampleAgeMs = null; activityContinuityReason = "native_poll_failed"; idleQualificationRemainingMs = null; engine?.sample(); } }
    finally { polling = false; }
}
function mode() {
    if (!settings.store.idle && !settings.store.camera) return settings.store.observe ? "Observation only" : "Observation only (history off)";
    if (!statusHooks) return "Automation unavailable";
    if (engine?.pausedRules.length) return "Automation paused";
    if (engine?.ownership) return "Plugin-owned status";
    if (settings.store.idle && !nativeIdleHook) return "Idle integration waiting for native hook";
    const s = read();
    return (s.effective === "online" || s.effective === "idle" && s.nativeIdleAttributed) && s.configured === "online" ? "Automation ready" : "Manual/external status protected";
}
function Panel() {
    const [, render] = useState(0);
    React.useEffect(() => { const update = () => render(n => n + 1); changes.add(update); void poll(); return () => { changes.delete(update); }; }, []);
    settings.use(["observe", "idle", "camera"]);
    const s = read();
    const [message, setMessage] = useState("");
    return <div style={{ padding: 16, maxHeight: "70vh", overflow: "auto" }}>
        <Forms.FormTitle>PresenceGuard — {mode()}</Forms.FormTitle>
        <Forms.FormText>Configured: {s.configured} · Local effective: {s.effective} · Local aggregate: {s.aggregate} · Owned: {engine?.ownership?.status ?? "no"}</Forms.FormText>
        <Forms.FormText>Latest: {engine?.latestDecision ?? "starting"}. Status hooks: {statusHooks ? "ready" : "unavailable"}; native Idle: {nativeIdleHook ? "ready" : "unavailable"}; save lifecycle: {saveHooks ? "tracked" : "unavailable"} ({patchError}).</Forms.FormText>
        <Forms.FormText>Desktop activity: {s.activity.value} — {s.activity.reason}. Idle counter: {activityIdleMs === null ? "unavailable/input sample pending" : `${Math.max(0, Math.round(activityIdleMs / 1000))}s`}; qualification remaining: {idleQualificationRemainingMs === null ? "unavailable" : `${Math.ceil(idleQualificationRemainingMs / 1000)}s`}; sample age: {activitySampleAgeMs === null ? "unavailable" : `${activitySampleAgeMs}ms`}; continuity: {activityContinuityReason ?? "continuous"}; helper: {helperSnapshotHealth} (sequence {helperSnapshotSequence ?? "unavailable"}). Configured-status signature: {configuredSignatureHealth}. Native Idle: {String(s.nativeIdle)} (attributed: {String(s.nativeIdleAttributed)}). Configured-status save evidence: {saveState}; pending write: {engine?.pendingPhase ?? "none"}.</Forms.FormText>
        {engine?.pausedDetails.map(item => <Forms.FormText key={item.rule}>Paused {item.rule}: {item.reason} at {new Date(item.at).toLocaleString()}</Forms.FormText>)}
        <Forms.FormText>Local storage: {persistenceHealth.summary}. Pending history events: {historyWriter.pendingCount}.</Forms.FormText>
        <Forms.FormText>Display: {s.display.value} — {s.display.reason}. Last sample: {s.display.at ? new Date(s.display.at).toLocaleTimeString() : "none"}.</Forms.FormText>
        <Forms.FormText>{describeDisplayFacts(s.display.facts)}. These facts do not prove the blanking cause.</Forms.FormText>
        <Forms.FormText>Camera: {s.camera.value} — {s.camera.reason}. {s.camera.scope}. Last sample: {s.camera.at ? new Date(s.camera.at).toLocaleTimeString() : "none"}.</Forms.FormText>
        <Forms.FormText>PipeWire: {pwCamera.value} — {pwCamera.reason}. Vesktop: {localCamera.value} — {localCamera.reason}.</Forms.FormText>
        <Forms.FormText>Local presence is not independent proof of what other sessions or users see. Simulations never change status.</Forms.FormText>
        <Forms.FormText>Desktop inactivity never uses phone activity. Local application, a correlated save acknowledgement, and mobile/server observations are separate evidence.</Forms.FormText>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
            <Button onClick={() => { settings.store.idle = !settings.store.idle; configure(); }}>Automatic Idle: {settings.store.idle ? "On" : "Off"}</Button>
            <Button onClick={() => { settings.store.camera = !settings.store.camera; configure(); }}>Webcam DND: {settings.store.camera ? "On" : "Off"}</Button>
            <Button onClick={() => engine?.resume()}>Resume paused rules</Button>
            <Button onClick={() => void persistenceHealth.run("history_write", () => historyWriter.flush()).then(() => Native.exportHistory()).then(ok => setMessage(ok ? "Export saved locally." : "Export cancelled.")).catch(() => setMessage("Export failed; check local storage health."))}>Export JSON</Button>
            <Button onClick={() => { if (confirm("Clear local PresenceGuard history?")) { historyGeneration++; void clearHistoryView(historyView, () => historyWriter.clear(() => persistenceHealth.run("history_clear", () => Native.clearHistory())), loadHistory).catch(() => setMessage("History could not be cleared. Reloaded saved events where readable; current events retained.")); } }}>Clear history</Button>
            <Button onClick={() => void simulate().then(lines => setMessage(`SIMULATION ONLY — ${lines.join("; ")}. No live status action was issued.`))}>Run fixture simulation</Button>
        </div>
        <Forms.FormText>{message}</Forms.FormText>
        <ol style={{ paddingLeft: 20 }}>{events.slice(-60).reverse().map((e, i) => <li key={`${e.at}-${i}`} style={{ marginBottom: 8 }}><Forms.FormText>{new Date(e.at).toLocaleString()} · {e.kind.toUpperCase()} · {e.source} · {e.previous} → {e.status} · configured {e.configured} · {e.reason} · owned {String(e.owned)}{e.saveState ? ` · save ${e.saveState}` : ""}{e.repeatCount && e.repeatCount > 1 ? ` · ${e.repeatCount} repeats (${new Date(e.firstAt ?? e.at).toLocaleTimeString()}–${new Date(e.lastAt ?? e.at).toLocaleTimeString()})` : ""}</Forms.FormText><Forms.FormText>Activity {e.activity?.value ?? "unavailable"}: {e.activity?.reason ?? "legacy history"} · native Idle attributed {String(e.nativeIdleAttributed ?? false)} · Display {e.display.value}: {e.display.reason} · {describeDisplayFacts(e.display.facts)} · Camera {e.camera.value}: {e.camera.reason}</Forms.FormText></li>)}</ol>
    </div>;
}
function openPanel() { openModal(props => <Modal {...props} title="PresenceGuard"><Panel /></Modal>); }
export default definePlugin({
    name: "PresenceGuard", description: "Local own-status history and conservative GNOME idle/webcam rules. Automation starts off.", authors: [{ name: "wouthh", id: 0n }], dependencies: ["UserSettingsAPI"], settings,
    patches: [actionPatch, protoPatch, saveLifecyclePatch, selectionPatch, cameraPatch, nativeIdlePatch], restartNeeded: false,
    settingsAboutComponent: () => <Button onClick={openPanel}>Open PresenceGuard history and detector panel</Button>,
    toolboxActions: { "PresenceGuard history": openPanel },
    statusAction(action: any) {
        if (!engine?.running) return;
        // The picker hook already revoked synchronously. Generic status actions
        // also represent native expiry and are not proof of a manual selection.
        if (action && manualActions.delete(action)) {
            const requestedAt = Date.now();
            const duration = typeof action.durationMillis === "number" && Number.isFinite(action.durationMillis) ? action.durationMillis : null;
            expectedManualStatus = { target: String(action.nextStatus), expiresAt: duration === null ? 0 : requestedAt + duration, until: requestedAt + 15_000 };
        }
        queueMicrotask(() => engine?.sample());
    },
    manualProviderReady() { manualHook = true; },
    manualOptions(action: any) {
        if (engine?.running) {
            const target = status(action.nextStatus);
            manualActions.add(action);
            const requestedAt = Date.now();
            const duration = typeof action.durationMillis === "number" && Number.isFinite(action.durationMillis) ? action.durationMillis : null;
            expectedManualStatus = { target, expiresAt: duration === null ? 0 : requestedAt + duration, until: requestedAt + 15_000 };
            provenance.clear(); saveState = "unavailable";
            engine.manual(target);
        }
        return action;
    },
    generatedUpdate(callback: object, proto: unknown) { provenance.generated(callback, proto); },
    saveQueued(owner: object, proto: object) {
        const token = provenance.saveQueued(owner, proto);
        if (token) { saveState = "pending"; engine?.saveOutcome(token, "pending", "client_status_save_queued_request_not_yet_confirmed"); }
    },
    saveStarted(owner: object, proto: unknown) { return provenance.saveStarted(owner, proto); },
    saveSucceeded(owner: object, context: any, proto: unknown) {
        const outcome = provenance.saveSucceeded(owner, context, proto);
        if (outcome.state === "succeeded") {
            saveState = "succeeded";
            for (const token of outcome.tokens) engine?.saveOutcome(token, "succeeded", "correlated_configured_status_save_acknowledgement");
        } else if (outcome.state === "unavailable") {
            saveState = "unavailable";
            for (const token of outcome.tokens) engine?.saveOutcome(token, "unavailable", "configured_status_save_acknowledgement_unmatched");
        }
    },
    saveUnavailable(owner: object, context: any) { return this.saveSucceeded(owner, context, null); },
    saveFailed(owner: object, context: any, kind: string) {
        const retrying = kind === "rate_limited";
        const tokens = provenance.saveFailed(owner, context, retrying);
        if (!tokens.length) return;
        if (retrying) {
            saveState = "pending";
            for (const token of tokens) engine?.saveOutcome(token, "pending", "configured_status_save_rate_limited_retrying");
            return;
        }
        saveState = "failed";
        for (const token of tokens) engine?.saveOutcome(token, "failed", `configured_status_save_failed_${kind}`);
    },
    nativeIdleProviderReady(reconcile: () => void) {
        if (!engine?.running) return;
        nativeIdleHook = true;
        nativeIdleReconcile = reconcile;
        validateHooks();
        engine.sample("native/client");
    },
    nativeIdleDecision(nativeEligible: boolean) {
        if (!pluginActive || !settings.store.idle) return nativeEligible;
        const configured = status(Configured.getSetting());
        const pluginOwnedIdle = engine?.ownership?.rule === "idle";
        return fresh(activity, Date.now()) && activity.value === "active" && (configured === "online" || pluginOwnedIdle) ? false : nativeEligible;
    },
    nativeIdleCurrent() { return Idle.isIdle() === true; },
    nativeIdleObserved(nativeEligible: boolean, localIdle: boolean) {
        const configured = status(Configured.getSetting());
        nativeIdleAttributed = pluginActive && settings.store.idle && Idle.isIdle() === true && isNativeAutomaticIdle(configured, nativeEligible, localIdle);
        engine?.sample("native/client");
    },
    nativeIdleDispatch(idle: boolean) {
        if (idle) nativeIdlePendingUntil = Date.now() + 2_000;
        else { nativeIdlePendingUntil = 0; nativeIdleAttributed = false; }
    },
    cameraProviderReady() { cameraHook = true; return true; },
    cameraAcquired(constraints: any, stream: MediaStream) {
        if (engine && !engine.running) return;
        if (!constraints?.video || constraints.video?.mandatory?.chromeMediaSource || constraints.video?.mediaSource) return;
        for (const track of stream.getVideoTracks()) {
            if ((track.getSettings() as any).displaySurface) continue;
            tracks.add(track);
        }
        void poll();
    },
    start() {
        lifecycle++;
        pluginActive = true;
        nativeIdleHook = false; nativeIdleReconcile = undefined; nativeIdleAttributed = false; nativeIdlePendingUntil = 0;
        saveState = "unavailable"; expectedManualStatus = null; configuredSignature = currentConfiguredSignature();
        display = UNKNOWN("GNOME"); activity = UNKNOWN("GNOME system-wide input"); pwCamera = UNKNOWN("PipeWire"); localCamera = UNKNOWN("Vesktop");
        helperSnapshotSequence = null; helperSnapshotAgeMs = null; helperSnapshotHealth = "starting"; activityIdleMs = null; activitySampleAgeMs = null; activityContinuityReason = null; idleQualificationRemainingMs = null;
        activityDetector.reset(); displayDetector.reset(); pipewireDetector.reset();
        validateHooks();
        try { connectionFresh = Gateway.isConnected() && !!UserStore.getCurrentUser() && UserSettingsProtoStore.hasLoaded(1); } catch { connectionFresh = false; }
        engine = new PresenceEngine({ read, write, record }, { now: Date.now, set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id as ReturnType<typeof setTimeout>) }, options());
        engine.boundary("plugin_start_new_detector_epoch");
        subscribe("USER_SETTINGS_PROTO_UPDATE", statusUpdate);
        subscribe("PRESENCE_UPDATE", event => { if ((event.user?.id ?? event.userId) === UserStore.getCurrentUser()?.id) queueMicrotask(() => engine?.sample()); });
        subscribe("IDLE", event => {
            if (event?.idle === false) { nativeIdleAttributed = false; nativeIdlePendingUntil = 0; }
            else if (event?.idle === true && nativeIdlePendingUntil >= Date.now()) {
                queueMicrotask(() => {
                    if (nativeIdlePendingUntil >= Date.now() && Idle.isIdle() === true) {
                        nativeIdleAttributed = true; nativeIdlePendingUntil = 0; engine?.sample("native/client");
                    }
                });
            }
            queueMicrotask(() => engine?.sample("native/client"));
        });
        for (const event of ["AFK", "SESSIONS_REPLACE"]) subscribe(event, () => queueMicrotask(() => engine?.sample("unknown")));
        for (const event of ["CONNECTION_CLOSED", "LOGOUT", "START_SESSION", "ACCOUNT_SWITCH_START"]) subscribe(event, () => { connectionFresh = false; nativeIdleAttributed = false; nativeIdlePendingUntil = 0; activityDetector.reset(true); activity = UNKNOWN("GNOME system-wide input", "reconnect_new_activity_epoch", Date.now()); engine?.boundary(event.toLowerCase()); provenance.clear(); });
        for (const event of ["CONNECTION_OPEN", "CONNECTION_RESUMED"]) subscribe(event, () => { connectionFresh = true; nativeIdleAttributed = false; nativeIdlePendingUntil = 0; activityDetector.reset(true); activity = UNKNOWN("GNOME system-wide input", "reconnect_new_activity_epoch", Date.now()); provenance.clear(); saveState = "unavailable"; engine?.boundary("connection_open_new_epoch"); nativeIdleReconcile?.(); queueMicrotask(() => engine?.sample()); });
        const epoch = lifecycle;
        void loadHistory().then(notify, notify);
        void Native.consumeWelcome().then(show => { if (show && epoch === lifecycle) openPanel(); });
        engine.sample(); interval = setInterval(() => void poll(), 2000); void poll();
    },
    stop() {
        lifecycle++; pluginActive = false; nativeIdleReconcile?.(); engine?.stop(); provenance.clear();
        for (const [event, fn] of subscriptions.splice(0)) FluxDispatcher.unsubscribe(event as any, fn);
        clearInterval(interval); interval = undefined;
        activityDetector.reset(); displayDetector.reset(); pipewireDetector.reset();
        cameraContinuity = false;
        tracks.clear();
        nativeIdleHook = false; nativeIdleReconcile = undefined; nativeIdleAttributed = false; nativeIdlePendingUntil = 0;
        display = UNKNOWN("GNOME"); activity = UNKNOWN("GNOME system-wide input"); pwCamera = UNKNOWN("PipeWire"); localCamera = UNKNOWN("Vesktop");
        void Native.lease(false);
        void persistenceHealth.diagnostics(() => Native.diagnostics({ enabled: false, commit: BUILD_INFO.commit, mode: "Stopped", storageHealth: persistenceHealth.summary }));
    }
});
