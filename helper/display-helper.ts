// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GLibUnix from "gi://GLibUnix";
import { activityForCurrentEpoch, watchRegistrationIsCurrent } from "./activity-epoch";
import { readHelperInput as read } from "./read-input";
import { loginSession } from "./login-session";
import { leaseActive, releaseMonitoring, startIdentity } from "./lifetime";
// Fixed installation paths are provided by an owner-only launcher, never the renderer.
const [parentText, parentStart, snapshotPath, leasePath] = ARGV;
if (!/^\d+$/.test(parentText ?? "") || !/^\d+$/.test(parentStart ?? "") || !snapshotPath?.startsWith("/") || !leasePath?.startsWith("/")) throw Error("invalid_helper_arguments");
const loop = new GLib.MainLoop(null, false);
function identity() {
    try { const s = read(`/proc/${parentText}/stat`); return startIdentity(s) === parentStart; } catch { return false; }
}
function write(value: unknown) {
    const file = Gio.File.new_for_path(snapshotPath);
    file.replace_contents(new TextEncoder().encode(JSON.stringify(value)), null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
function call(bus: any, name: string, path: string, iface: string, method: string, params: any = null): Promise<any> {
    return new Promise((resolve, reject) => bus.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, 1500, null, (_: unknown, result: unknown) => {
        try { resolve(bus.call_finish(result).deepUnpack()); } catch { reject(Error("dbus_unavailable")); }
    }));
}
const session = Gio.DBus.session;
const system = Gio.DBus.system;
const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.session" });
const instance = GLib.uuid_string_random();
let provider = 0;
let lastLease = false;
let busy = false;
let lastStart = 0;
let lockIdentity = "";
let login1Owner = "";
let login1SessionEpoch = 0;
let login1FactsEpoch = 0;
let idleMonitorOwner = "";
let activityProviderEpoch = 0;
let activitySerial = 0;
let activityAt = 0;
let activeWatch: number | null = null;
let activeWatchOwner = "";
let activeWatchEpoch = -1;
let watchBusy = false;
const pendingActiveSignals = new Set<number>();
const uid = new Gio.Credentials().get_unix_user();
const ids: { bus: any; id: number }[] = [];
function subscribe(bus: any, name: string, iface: string, signal: string, path: string | null, fn: (...args: any[]) => void) {
    ids.push({ bus, id: bus.signal_subscribe(name, iface, signal, path, null, Gio.DBusSignalFlags.NONE, fn) });
}
async function addUserActiveWatch() {
    if (!lastLease || !idleMonitorOwner || activeWatch !== null || watchBusy) return;
    const requestedOwner = idleMonitorOwner;
    const requestedEpoch = activityProviderEpoch;
    watchBusy = true;
    let rearm = false;
    try {
        // Address the captured owner directly so a name handoff cannot register
        // the watch on a new owner while we later try to remove it from the old one.
        const result = await call(session, requestedOwner, "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "AddUserActiveWatch");
        const id = Number(result[0]);
        if (!Number.isInteger(id) || id < 0) throw Error("invalid_idle_watch_id");
        const registrationCurrent = watchRegistrationIsCurrent(requestedOwner, requestedEpoch, idleMonitorOwner, activityProviderEpoch);
        if (!lastLease || !identity() || !registrationCurrent) {
            pendingActiveSignals.clear();
            await call(session, requestedOwner, "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "RemoveWatch", new GLib.Variant("(u)", [id]));
            rearm = registrationCurrent === false && lastLease && identity() && !!idleMonitorOwner;
        } else if (pendingActiveSignals.delete(id)) {
            activitySerial++; activityAt = Date.now(); rearm = true;
        } else { activeWatch = id; activeWatchOwner = requestedOwner; activeWatchEpoch = requestedEpoch; }
    } catch {
        activeWatch = null; activeWatchOwner = ""; activeWatchEpoch = -1;
        rearm = lastLease && identity() && !!idleMonitorOwner
            && !watchRegistrationIsCurrent(requestedOwner, requestedEpoch, idleMonitorOwner, activityProviderEpoch);
    }
    finally { watchBusy = false; if (rearm && lastLease) { void observe(); void addUserActiveWatch(); } }
}
async function removeUserActiveWatch() {
    const id = activeWatch;
    const owner = activeWatchOwner;
    activeWatch = null;
    activeWatchOwner = "";
    activeWatchEpoch = -1;
    pendingActiveSignals.clear();
    if (id === null || !owner) return;
    try { await call(session, owner, "/org/gnome/Mutter.IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "RemoveWatch", new GLib.Variant("(u)", [id])); } catch { /* A vanished provider already removed the watch. */ }
}
async function resetUserActiveWatch() {
    await removeUserActiveWatch();
    if (lastLease && idleMonitorOwner) await addUserActiveWatch();
}
async function observe() {
    if (busy) return;
    if (!identity()) { cleanup(); loop.quit(); return; }
    let enabled = false;
    try { enabled = leaseActive(JSON.parse(read(leasePath)), Date.now()); } catch { /* Missing lease stops collection. */ }
    if (!enabled) {
        const wasEnabled = lastLease;
        lastLease = false;
        releaseMonitoring(() => { if (wasEnabled) write({ version: 1, at: Date.now(), observation: null, reason: "lease_inactive" }); }, unsubscribe);
        return;
    }
    if (!lastLease) { provider++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; startSubscriptions(); }
    lastLease = true;
    busy = true;
    const at = Date.now();
    if (lastStart && at - lastStart > 10000) provider++;
    lastStart = at;
    let activityObservation: Record<string, unknown> | null = null;
    let activityObservationEpoch: number | null = null;
    let sessionLock: { locked: boolean; identity: string } | null = null;
    let sessionIdentityAtSample: string | null = null;
    let sessionValidated = false;
    const activitySampleEpoch = activityProviderEpoch;
    const sessionIdentityEpochAtSample = login1SessionEpoch;
    const sessionFactsEpochAtSample = login1FactsEpoch;
    try {
        const [activityResults, sessionResults] = await Promise.all([
            Promise.allSettled([
                call(session, "org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime"),
                call(session, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", new GLib.Variant("(s)", ["org.gnome.Mutter.IdleMonitor"])),
                call(system, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.DBus.Properties", "Get", new GLib.Variant("(ss)", ["org.freedesktop.login1.Manager", "PreparingForSleep"]))
            ]),
            Promise.allSettled([
                call(system, "org.freedesktop.login1", "/org/freedesktop/login1/session/auto", "org.freedesktop.DBus.Properties", "GetAll", new GLib.Variant("(s)", ["org.freedesktop.login1.Session"])),
                call(system, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", new GLib.Variant("(s)", ["org.freedesktop.login1"]))
            ])
        ]);
        const [sessionResult, loginOwnerResult] = sessionResults;
        if (sessionResult.status === "fulfilled" && loginOwnerResult.status === "fulfilled") {
            try {
                const lock = loginSession(Object.fromEntries(["User", "Active", "Type", "Class", "LockedHint", "Id"].map(key => [key, sessionResult.value[0][key].deepUnpack()])), uid);
                const nextLogin1Owner = String(loginOwnerResult.value[0]);
                if (!nextLogin1Owner) throw Error("login1_owner_unavailable");
                const nextLockIdentity = `${nextLogin1Owner}:${lock.identity}`;
                if (nextLockIdentity !== lockIdentity) {
                    provider++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; lockIdentity = nextLockIdentity;
                }
                login1Owner = nextLogin1Owner;
                sessionLock = lock;
                sessionIdentityAtSample = nextLockIdentity;
                sessionValidated = sessionIdentityEpochAtSample === login1SessionEpoch;
            } catch { /* A missing or mismatched login session is not valid activity evidence. */ }
        }
        if (!sessionValidated) {
            provider++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; login1SessionEpoch++; login1FactsEpoch++; lockIdentity = ""; login1Owner = "";
        }
        const [idleResult, idleOwnerResult, sleepResult] = activityResults;
        if (idleResult.status === "fulfilled" && idleOwnerResult.status === "fulfilled" && sleepResult.status === "fulfilled") {
            const [idle, idleOwner, sleep] = [idleResult.value, idleOwnerResult.value, sleepResult.value];
            const nextIdleOwner = String(idleOwner[0]);
            if (nextIdleOwner !== idleMonitorOwner) {
                activityProviderEpoch++; activitySerial = 0; activityAt = 0;
                if (activeWatch !== null) void removeUserActiveWatch();
                else { activeWatchOwner = ""; activeWatchEpoch = -1; pendingActiveSignals.clear(); }
                idleMonitorOwner = nextIdleOwner;
            }
            if (lastLease && idleMonitorOwner) void addUserActiveWatch();
            if (sessionValidated && activitySampleEpoch === activityProviderEpoch) {
                activityObservationEpoch = activitySampleEpoch;
                activityObservation = { at: Date.now(), idleMs: Number(idle[0]), suspended: sleep[0].deepUnpack(), provider: `${idleMonitorOwner}:${instance}:${activityObservationEpoch}`, activitySerial, activityAt };
            }
        } else {
            activityProviderEpoch++; activitySerial = 0; activityAt = 0; idleMonitorOwner = "";
            await removeUserActiveWatch();
        }
    } catch {
        provider++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; login1SessionEpoch++; login1FactsEpoch++;
        idleMonitorOwner = ""; lockIdentity = ""; login1Owner = ""; sessionLock = null; sessionIdentityAtSample = null; sessionValidated = false;
        activityObservation = null; activityObservationEpoch = null;
        await removeUserActiveWatch();
    }
    try {
        const [power, shield, topology, owner] = await Promise.all([
            call(session, "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.freedesktop.DBus.Properties", "Get", new GLib.Variant("(ss)", ["org.gnome.Mutter.DisplayConfig", "PowerSaveMode"])),
            call(session, "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "GetActive"),
            call(session, "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", "GetCurrentState"),
            call(session, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", new GLib.Variant("(s)", ["org.gnome.Mutter.DisplayConfig"]))
        ]);
        const sessionIdentityCurrent = sessionValidated && sessionLock !== null && sessionIdentityAtSample === lockIdentity && sessionIdentityEpochAtSample === login1SessionEpoch;
        const sessionFactsCurrent = sessionIdentityCurrent && sessionFactsEpochAtSample === login1FactsEpoch;
        const currentActivity = activityForCurrentEpoch(activityObservation, activityObservationEpoch, activityProviderEpoch, sessionIdentityCurrent);
        const logical = topology[2];
        if (!Array.isArray(logical)) throw Error();
        // Do not persist monitor names/serials. Geometry and connector count suffice for continuity.
        const shape = logical.map((m: any[]) => [m[0], m[1], m[2], m[3], m[5]?.length]);
        if (!sessionFactsCurrent) {
            if (lastLease && identity()) write({ version: 1, at: Date.now(), observation: null, activity: currentActivity, reason: "session_unavailable" });
        } else {
            // ScreenSaver.GetActive is screen-shield activity, not proof of locking.
            // GNOME writes actual lock state to login1 Session.LockedHint.
            const observation = { at: Date.now(), power: power[0].deepUnpack(), idleMs: currentActivity?.idleMs ?? -1, thresholdMs: settings.get_uint("idle-delay") * 1000, locked: sessionLock!.locked, shieldActive: shield[0], suspended: currentActivity?.suspended ?? true, topology: JSON.stringify(shape), monitors: logical.length, provider: `${owner[0]}:${instance}:${provider}` };
            if (lastLease && identity()) write({ version: 1, at: Date.now(), observation, activity: currentActivity });
        }
    } catch {
        provider++;
        const sessionIdentityCurrent = sessionValidated && sessionLock !== null && sessionIdentityAtSample === lockIdentity && sessionIdentityEpochAtSample === login1SessionEpoch;
        const sessionFactsCurrent = sessionIdentityCurrent && sessionFactsEpochAtSample === login1FactsEpoch;
        const currentActivity = activityForCurrentEpoch(activityObservation, activityObservationEpoch, activityProviderEpoch, sessionIdentityCurrent);
        write({ version: 1, at: Date.now(), observation: null, activity: currentActivity, reason: sessionFactsCurrent ? "display_provider_unavailable" : "session_unavailable" });
    }
    finally { busy = false; }
}
function startSubscriptions() {
    subscribe(system, "org.freedesktop.login1", "org.freedesktop.DBus.Properties", "PropertiesChanged", null, (...args: any[]) => {
        if (args[2] === "/org/freedesktop/login1/session/auto") {
            const [iface, changed, invalidated] = args[5]?.deepUnpack?.() ?? [];
            if (iface === "org.freedesktop.login1.Session") {
                const names = new Set<string>([...Object.keys(changed ?? {}), ...(Array.isArray(invalidated) ? invalidated : [])]);
                if (["User", "Active", "Type", "Class", "Id", "LockedHint"].some(name => names.has(name))) login1FactsEpoch++;
                if (["User", "Active", "Type", "Class", "Id"].some(name => names.has(name))) {
                    provider++; login1SessionEpoch++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; lockIdentity = "";
                    void resetUserActiveWatch();
                }
            }
        }
        void observe();
    });
    subscribe(system, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", (...args: any[]) => {
        const [name, , nextOwner] = args[5]?.deepUnpack?.() ?? [];
        if (name !== "org.freedesktop.login1") return;
        const next = String(nextOwner ?? "");
        if (next === login1Owner) return;
        login1Owner = next; lockIdentity = ""; provider++; login1SessionEpoch++; login1FactsEpoch++;
        activityProviderEpoch++; activitySerial = 0; activityAt = 0;
        void resetUserActiveWatch();
        void observe();
    });
    subscribe(system, "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep", "/org/freedesktop/login1", () => { provider++; activityProviderEpoch++; activitySerial = 0; activityAt = 0; void resetUserActiveWatch(); void observe(); });
    subscribe(session, "org.gnome.Mutter.DisplayConfig", "org.freedesktop.DBus.Properties", "PropertiesChanged", "/org/gnome/Mutter/DisplayConfig", () => { void observe(); });
    subscribe(session, "org.gnome.Mutter.DisplayConfig", "org.gnome.Mutter.DisplayConfig", "MonitorsChanged", "/org/gnome/Mutter/DisplayConfig", () => { provider++; void observe(); });
    subscribe(session, "org.gnome.ScreenSaver", "org.gnome.ScreenSaver", "ActiveChanged", "/org/gnome/ScreenSaver", () => { void observe(); });
    subscribe(session, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", (...args: any[]) => {
        const [name, , nextOwner] = args[5]?.deepUnpack?.() ?? [];
        if (name !== "org.gnome.Mutter.IdleMonitor") return;
        idleMonitorOwner = String(nextOwner ?? "");
        activityProviderEpoch++; activitySerial = 0; activityAt = 0; activeWatch = null; activeWatchOwner = ""; activeWatchEpoch = -1; pendingActiveSignals.clear();
        if (idleMonitorOwner && lastLease) void addUserActiveWatch();
        void observe();
    });
    subscribe(session, "org.gnome.Mutter.IdleMonitor", "org.gnome.Mutter.IdleMonitor", "WatchFired", "/org/gnome/Mutter/IdleMonitor/Core", (...args: any[]) => {
        const [id] = args[5]?.deepUnpack?.() ?? [];
        if (activeWatch === null) { if (watchBusy && Number.isInteger(Number(id))) pendingActiveSignals.add(Number(id)); return; }
        if (Number(id) !== activeWatch) return;
        const watchOwner = activeWatchOwner;
        const watchEpoch = activeWatchEpoch;
        activeWatch = null;
        activeWatchOwner = "";
        activeWatchEpoch = -1;
        if (watchEpoch !== activityProviderEpoch || watchOwner !== idleMonitorOwner) {
            void observe();
            if (lastLease && idleMonitorOwner) void addUserActiveWatch();
            return;
        }
        activitySerial++;
        activityAt = Date.now();
        void addUserActiveWatch();
        void observe();
    });
}
function unsubscribe() {
    for (const { bus, id } of ids.splice(0)) bus.signal_unsubscribe(id);
    void removeUserActiveWatch();
}
const interval = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { void observe(); return GLib.SOURCE_CONTINUE; });
function cleanup() {
    unsubscribe();
    GLib.source_remove(interval);
    try { write({ version: 1, at: Date.now(), observation: null, reason: "helper_stopped" }); } catch { /* Parent may have removed installation. */ }
}
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => { cleanup(); loop.quit(); return GLib.SOURCE_REMOVE; });
// Start only after entering the main loop so an already-exited parent can quit it.
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { void observe(); return GLib.SOURCE_REMOVE; });
loop.run();
