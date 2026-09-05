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
import { cameraSnapshot, PipeWireDetector } from "./core/camera";
import { DisplayDetector } from "./core/display";
import { PresenceEngine } from "./core/engine";
import { retain } from "./core/history";
import { statusMutator } from "./core/mutator";
import { Provenance } from "./core/provenance";
import { simulate } from "./core/simulation";
import { CameraTracks } from "./core/tracks";
import { HistoryEvent, Options, Snapshot, status, UNKNOWN, WriteToken } from "./core/types";
import { actionPatch, cameraPatch, protoPatch, selectionPatch } from "./patches";

const Native = VencordNative.pluginHelpers.PresenceGuard as PluginNative<typeof import("./native")>;
const Configured = getUserSettingLazy<string>("status", "status")!;
const SelfPresence = findStoreLazy("SelfPresenceStore");
const AggregatePresence = findStoreLazy("PresenceStore");
const Gateway = findStoreLazy("GatewayConnectionStore");
const Idle = findStoreLazy("IdleStore");
const Voice = findStoreLazy("RTCConnectionStore");
const provenance = new Provenance();
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
let cameraHook = false;
let cameraContinuity = true;
let connectionFresh = false;
let panelMounted = false;
let patchError = "starting";
let updater: any;
let connectionStates: any;
let delay: number;
let events: HistoryEvent[] = [];
let display = UNKNOWN("GNOME");
let pwCamera = UNKNOWN("PipeWire");
let localCamera = UNKNOWN("Vesktop");
const changes = new Set<() => void>();
const notify = () => changes.forEach(fn => fn());
const settings = definePluginSettings({
    observe: { type: OptionType.BOOLEAN, description: "Keep bounded local own-status history", default: true, onChange: () => configure() },
    idle: { type: OptionType.BOOLEAN, description: "Automatic Idle on confirmed inactivity-associated display blanking", default: false, onChange: () => configure() },
    camera: { type: OptionType.BOOLEAN, description: "Automatic DND on confirmed webcam capture (partial coverage)", default: false, onChange: () => configure() }
});
function options(): Options { return { observe: settings.store.observe, idle: settings.store.idle, camera: settings.store.camera }; }
function read(): Snapshot {
    try {
        const account = UserStore.getCurrentUser()?.id ?? null;
        return { account, connected: connectionFresh && Gateway.isConnected() && Gateway.getSocket()?.connectionState === connectionStates?.SESSION_ESTABLISHED, capable: statusHooks, configured: status(Configured.getSetting()), effective: status(SelfPresence.getStatus()), aggregate: account ? status(AggregatePresence.getStatus(account, null, "unknown")) : "unknown", nativeIdle: typeof Idle.isIdle() === "boolean" ? Idle.isIdle() : null, display, camera: cameraSnapshot(pwCamera, localCamera, Date.now(), cameraContinuity) };
    } catch { return { account: null, connected: false, capable: false, configured: "unknown", effective: "unknown", aggregate: "unknown", nativeIdle: null, display, camera: UNKNOWN("Partial", "client_stores_unavailable") }; }
}
function record(event: HistoryEvent) {
    events = retain([...events, event], Date.now());
    void Native.appendHistory(event).catch(() => { patchError = "local_history_write_failed"; notify(); });
    notify();
}
function configure() { engine?.configure(options()); notify(); }
function validateHooks() {
    try {
        if (!manualHook) {
            const id = findModuleId(/let\{status:\w+,currentStatus:\w+,description:/);
            if (id != null) wreq(id);
        }
        const action = findByCode("nextStatus:", "statusCreatedAtMs");
        updater = findByProps("updateAsync", "markDirty");
        connectionStates = findByProps("SESSION_ESTABLISHED", "RESUMING");
        delay = findByProps("INFREQUENT_USER_ACTION", "AUTOMATED")?.INFREQUENT_USER_ACTION;
        const conflict = ["CustomIdle", "AutoDNDWhilePlaying"].some(name => Vencord.Settings.plugins[name]?.enabled);
        statusHooks = connectionStates?.SESSION_ESTABLISHED !== undefined && manualHook && typeof action === "function" && action.toString().includes(".statusAction(") && typeof updater?.updateAsync === "function" && updater.updateAsync.toString().includes(".generatedUpdate(") && Number.isFinite(delay) && UserSettingsProtoStore.hasLoaded(1) && !conflict;
        patchError = conflict ? "conflicting_status_plugin_enabled" : statusHooks ? "none" : "required_status_hooks_unavailable";
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
    if (!proto?.status || !["status", "statusExpiresAtMs", "statusCreatedAtMs"].some(key => Object.hasOwn(proto.status, key))) return;
    const token = provenance.take(proto);
    if (!token) engine?.external(event.local === false ? "external" : "unknown");
    queueMicrotask(() => engine?.sample(token ? "plugin" : "unknown", token));
}
async function poll() {
    if (polling || !engine?.running) return;
    polling = true;
    const epoch = lifecycle;
    try {
        validateHooks();
        await Native.lease(true);
        const [d, camera] = await Promise.all([Native.displaySnapshot(), Native.pipeWireSnapshot()]);
        if (epoch !== lifecycle || !engine?.running) return;
        display = displayDetector.observe(d);
        pwCamera = camera === null ? UNKNOWN("PipeWire", "pipewire_unavailable", Date.now()) : pipewireDetector.parse(camera, Date.now());
        tracks.prune();
        localCamera = !cameraHook || !cameraContinuity ? UNKNOWN("Vesktop", "camera_hook_or_continuity_unavailable", Date.now()) : { value: tracks.live ? "active" : tracks.size ? "unknown" : "inactive", at: Date.now(), scope: "Vesktop observed camera acquisitions", reason: tracks.size ? "camera_track_live_muted_or_disabled" : "no_observed_live_camera_track" };
        engine.sample();
        const s = read();
        await Native.diagnostics({ commit: BUILD_INFO.commit, enabled: true, idle: settings.store.idle, camera: settings.store.camera, owned: !!engine.ownership, configured: s.configured, effective: s.effective, aggregate: s.aggregate, decision: engine.latestDecision, mode: mode(), displayReason: display.reason, cameraReason: s.camera.reason, statusHooks, cameraHook, panelMounted, voiceConnected: !!Voice.getChannelId(), localCameraLive: tracks.size > 0, patchError });
        notify();
    } catch { if (epoch === lifecycle) { display = UNKNOWN("GNOME", "native_poll_failed"); pwCamera = UNKNOWN("PipeWire", "native_poll_failed"); engine?.sample(); } }
    finally { polling = false; }
}
function mode() {
    if (!settings.store.idle && !settings.store.camera) return "Observation only";
    if (!statusHooks) return "Automation unavailable";
    if (engine?.pausedRules.length) return "Automation paused";
    if (engine?.ownership) return "Plugin-owned status";
    const s = read();
    return s.effective === "online" && s.configured === "online" ? "Automation ready" : "Manual/external status protected";
}
function Panel() {
    const [, render] = useState(0);
    React.useEffect(() => { const update = () => render(n => n + 1); changes.add(update); panelMounted = true; void poll(); return () => { changes.delete(update); }; }, []);
    settings.use(["observe", "idle", "camera"]);
    const s = read();
    const [message, setMessage] = useState("");
    return <div style={{ padding: 16, maxHeight: "70vh", overflow: "auto" }}>
        <Forms.FormTitle>PresenceGuard — {mode()}</Forms.FormTitle>
        <Forms.FormText>Configured: {s.configured} · Local effective: {s.effective} · Local aggregate: {s.aggregate} · Owned: {engine?.ownership?.status ?? "no"}</Forms.FormText>
        <Forms.FormText>Latest: {engine?.latestDecision ?? "starting"}. Safety hooks: {patchError}.</Forms.FormText>
        <Forms.FormText>Display: {s.display.value} — {s.display.reason}. Last sample: {s.display.at ? new Date(s.display.at).toLocaleTimeString() : "none"}.</Forms.FormText>
        <Forms.FormText>Camera: {s.camera.value} — {s.camera.reason}. {s.camera.scope}. Last sample: {s.camera.at ? new Date(s.camera.at).toLocaleTimeString() : "none"}.</Forms.FormText>
        <Forms.FormText>Local presence is not independent proof of what other sessions or users see. Simulations never change status.</Forms.FormText>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
            <Button onClick={() => { settings.store.idle = !settings.store.idle; configure(); }}>Automatic Idle: {settings.store.idle ? "On" : "Off"}</Button>
            <Button onClick={() => { settings.store.camera = !settings.store.camera; configure(); }}>Webcam DND: {settings.store.camera ? "On" : "Off"}</Button>
            <Button onClick={() => engine?.resume()}>Resume paused rules</Button>
            <Button onClick={() => void Native.exportHistory().then(ok => setMessage(ok ? "Export saved locally." : "Export cancelled.")).catch(() => setMessage("Export failed; existing files are never overwritten."))}>Export JSON</Button>
            <Button onClick={() => { if (confirm("Clear local PresenceGuard history?")) void Native.clearHistory().then(() => { events = []; notify(); }); }}>Clear history</Button>
            <Button onClick={() => void simulate().then(lines => setMessage(`SIMULATION ONLY — ${lines.join("; ")}. No live status action was issued.`))}>Run fixture simulation</Button>
        </div>
        <Forms.FormText>{message}</Forms.FormText>
        <ol style={{ paddingLeft: 20 }}>{events.slice(-60).reverse().map((e, i) => <li key={`${e.at}-${i}`} style={{ marginBottom: 8 }}><Forms.FormText>{new Date(e.at).toLocaleString()} · {e.kind.toUpperCase()} · {e.source} · {e.previous} → {e.status} · configured {e.configured} · {e.reason} · owned {String(e.owned)}</Forms.FormText></li>)}</ol>
    </div>;
}
function openPanel() { openModal(props => <Modal {...props} title="PresenceGuard"><Panel /></Modal>); }
export default definePlugin({
    name: "PresenceGuard", description: "Local own-status history and conservative GNOME idle/webcam rules. Automation starts off.", authors: [{ name: "wouthh", id: 0n }], dependencies: ["UserSettingsAPI"], settings,
    patches: [actionPatch, protoPatch, selectionPatch, cameraPatch], restartNeeded: false,
    settingsAboutComponent: () => <Button onClick={openPanel}>Open PresenceGuard history and detector panel</Button>,
    toolboxActions: { "PresenceGuard history": openPanel },
    statusAction(action: any) {
        if (!engine?.running) return;
        // This common path also receives native expiry actions. Attribution stays unknown;
        // every invocation still revokes ownership, including same-value picker selections.
        if (!action || !manualActions.delete(action)) engine?.external("unknown");
        queueMicrotask(() => engine?.sample());
    },
    manualProviderReady() { manualHook = true; },
    manualOptions(action: any) { if (engine?.running) { manualActions.add(action); engine.manual(status(action.nextStatus)); } return action; },
    generatedUpdate(callback: object, proto: unknown) { provenance.generated(callback, proto); },
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
        display = UNKNOWN("GNOME"); pwCamera = UNKNOWN("PipeWire"); localCamera = UNKNOWN("Vesktop");
        displayDetector.reset(); pipewireDetector.reset();
        validateHooks();
        try { connectionFresh = Gateway.isConnected() && !!UserStore.getCurrentUser() && UserSettingsProtoStore.hasLoaded(1); } catch { connectionFresh = false; }
        engine = new PresenceEngine({ read, write, record }, { now: Date.now, set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id as ReturnType<typeof setTimeout>) }, options());
        engine.boundary("plugin_start_new_detector_epoch");
        subscribe("USER_SETTINGS_PROTO_UPDATE", statusUpdate);
        subscribe("PRESENCE_UPDATE", event => { if ((event.user?.id ?? event.userId) === UserStore.getCurrentUser()?.id) queueMicrotask(() => engine?.sample()); });
        for (const event of ["IDLE", "AFK", "SESSIONS_REPLACE"]) subscribe(event, () => queueMicrotask(() => engine?.sample(event === "IDLE" ? "native/client" : "unknown")));
        for (const event of ["CONNECTION_CLOSED", "LOGOUT", "START_SESSION", "ACCOUNT_SWITCH_START"]) subscribe(event, () => { connectionFresh = false; engine?.boundary(event.toLowerCase()); provenance.clear(); });
        for (const event of ["CONNECTION_OPEN", "CONNECTION_RESUMED"]) subscribe(event, () => { connectionFresh = true; engine?.boundary("connection_open_new_epoch"); queueMicrotask(() => engine?.sample()); });
        const epoch = lifecycle;
        void Native.readHistory().then(history => { if (epoch === lifecycle) { events = retain([...history, ...events], Date.now()).filter((e, i, all) => all.findIndex(x => x.at === e.at && x.kind === e.kind && x.reason === e.reason) === i); notify(); } }).catch(() => { patchError = "history_unavailable_preserved"; });
        void Native.consumeWelcome().then(show => { if (show && epoch === lifecycle) openPanel(); });
        engine.sample(); interval = setInterval(() => void poll(), 2000); void poll();
    },
    stop() {
        lifecycle++; engine?.stop(); provenance.clear();
        for (const [event, fn] of subscriptions.splice(0)) FluxDispatcher.unsubscribe(event as any, fn);
        clearInterval(interval); interval = undefined;
        displayDetector.reset(); pipewireDetector.reset();
        cameraContinuity = false;
        tracks.clear();
        display = UNKNOWN("GNOME"); pwCamera = UNKNOWN("PipeWire"); localCamera = UNKNOWN("Vesktop");
        void Native.lease(false);
        void Native.diagnostics({ enabled: false, commit: BUILD_INFO.commit, mode: "Stopped" });
    }
});
