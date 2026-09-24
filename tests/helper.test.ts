// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

test("production helper enters its loop before quitting for an already-exited parent", () => {
    const source = buildSync({ entryPoints: ["helper/display-helper.ts"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["gi://Gio", "gi://GioUnix", "gi://GLib", "gi://GLibUnix"] }).outputFiles[0].text;
    const callbacks: (() => void)[] = []; let running = false; let writes = 0; let removed = false;
    const glib = {
        MainLoop: class { run() { running = true; for (const fn of callbacks.splice(0)) fn(); if (running) throw Error("loop_did_not_terminate"); } quit() { running = false; } },
        uuid_string_random: () => "synthetic-instance",
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        idle_add: (_: unknown, fn: () => void) => { callbacks.push(fn); }, timeout_add_seconds: () => 1, source_remove: () => { removed = true; },
        open: () => { throw Error("parent_exited"); }
    };
    const gio = { Credentials: class { get_unix_user() { return 777; } }, DBus: { session: {}, system: {} }, Settings: class {}, File: { new_for_path: () => ({ replace_contents: () => { writes++; } }) }, FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 } };
    runInNewContext(source, { ARGV: ["123", "456", "/synthetic/snapshot", "/synthetic/lease"], TextDecoder, TextEncoder, require: (name: string) => ({ "gi://Gio": gio, "gi://GioUnix": {}, "gi://GLib": glib, "gi://GLibUnix": { signal_add: () => 1 } })[name] });
    assert.equal(running, false); assert.equal(removed, true); assert.equal(writes, 1);
});

test("production helper re-reads sleep state after a resume signal missed without a lease", async () => {
    const source = buildSync({ entryPoints: ["helper/display-helper.ts"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["gi://Gio", "gi://GioUnix", "gi://GLib", "gi://GLibUnix"] }).outputFiles[0].text;
    let enabled = true, sleeping = true, regularLease = true, loginSessionUnavailable = false, sessionId = "synthetic-session", deferDisplayQuery = false, releaseDisplayQuery: (() => void) | null = null, desktopIdleMs = 0, snapshot: any, tick!: () => void;
    const snapshots: any[] = [];
    const idle: (() => void)[] = [], subscriptions = new Map<number, { name: string; signal: string; path: string | null; fn: (...args: any[]) => void }>(); let next = 1, nextWatch = 0;
    const removedWatches: { owner: string; path: string; id: number }[] = [];
    const descriptors = new Map<number, string>(); let nextFd = 10;
    class Variant { constructor(_type: string, public value: any) {} deepUnpack() { return this.value; } }
    const bus = {
        call: (name: string, path: string, _iface: string, method: string, params: Variant | null, _reply: unknown, _flags: unknown, _timeout: unknown, _cancel: unknown, callback: (bus: unknown, result: any) => void) => {
            if (method === "GetAll" && loginSessionUnavailable) { queueMicrotask(() => callback(null, { failed: true })); return; }
            const value = method === "GetIdletime" ? [desktopIdleMs] : method === "GetAll" ? [Object.fromEntries(Object.entries({ User: [777, "/synthetic/user"], Active: true, Type: "wayland", Class: "user", LockedHint: false, Id: sessionId }).map(([key, value]) => [key, new Variant("v", value)]))] : method === "GetSession" ? [sessionId === "synthetic-session" ? "/org/freedesktop/login1/session/_synthetic" : "/org/freedesktop/login1/session/_replacement"] : method === "AddUserActiveWatch" ? [++nextWatch] : method === "RemoveWatch" ? [removedWatches.push({ owner: name, path, id: Number(params?.value[0]) })] : method === "Get" ? [new Variant("v", params?.value[1] === "PreparingForSleep" ? sleeping : 0)]
                : method === "GetCurrentState" ? [0, [], [[0, 0, 1, 0, false, ["synthetic"]]]]
                    : method === "GetActive" ? [false] : method === "GetNameOwner" ? [params?.value[0] === "org.gnome.Mutter.IdleMonitor" ? ":1.20" : params?.value[0] === "org.freedesktop.login1" ? ":1.5" : "synthetic-provider"] : [0];
            const result = { deepUnpack: () => value };
            if (method === "GetCurrentState" && deferDisplayQuery) { deferDisplayQuery = false; releaseDisplayQuery = () => callback(null, result); return; }
            queueMicrotask(() => callback(null, result));
        },
        call_finish: (result: any) => { if (result.failed) throw Error("synthetic_login1_unavailable"); return result; },
        signal_subscribe: (name: string, _iface: string, signal: string, path: string | null, _arg: unknown, _flags: unknown, fn: (...args: any[]) => void) => { const id = next++; subscriptions.set(id, { name, signal, path, fn }); return id; },
        signal_unsubscribe: (id: number) => subscriptions.delete(id)
    };
    const glib = {
        Variant, uuid_string_random: () => "synthetic-instance", PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        MainLoop: class { run() { for (const fn of idle.splice(0)) fn(); } quit() {} },
        idle_add: (_: unknown, fn: () => void) => idle.push(fn), timeout_add_seconds: (_: unknown, _seconds: number, fn: () => void) => { tick = fn; return 1; }, source_remove: () => {},
        open: (path: string) => { const fd = nextFd++; descriptors.set(fd, path); return fd; }
    };
    const gio = { Credentials: class { get_unix_user() { return 777; } }, DBus: { session: bus, system: bus }, DBusCallFlags: { NO_AUTO_START: 1 }, DBusSignalFlags: { NONE: 0 }, Settings: class { get_uint() { return 300; } }, FileType: { REGULAR: 1 }, FileQueryInfoFlags: { NONE: 0 }, File: { new_for_path: (path: string) => ({ query_info: () => ({ get_file_type: () => descriptors.get(Number(path.split("/").at(-1)))?.startsWith("/proc/") || regularLease ? 1 : 4, get_size: () => 0 }), replace_contents: (bytes: Uint8Array) => { snapshot = JSON.parse(new TextDecoder().decode(bytes)); snapshots.push(snapshot); } }) }, FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 } };
    const gioUnix = { InputStream: class {
        fd: number; constructor({ fd }: { fd: number }) { this.fd = fd; }
        read_bytes() { const path = descriptors.get(this.fd)!; assert(path.startsWith("/proc/") || regularLease, "must not read a non-regular lease"); return { get_data: () => new TextEncoder().encode(path.startsWith("/proc/") ? `123 (synthetic) ${Array.from({ length: 20 }, (_, i) => i === 19 ? "456" : "0").join(" ")}` : JSON.stringify({ enabled, at: Date.now() })) }; }
        close() { descriptors.delete(this.fd); }
    } };
    runInNewContext(source, { ARGV: ["123", "456", "/synthetic/snapshot", "/synthetic/lease"], TextDecoder, TextEncoder, require: (name: string) => ({ "gi://Gio": gio, "gi://GioUnix": gioUnix, "gi://GLib": glib, "gi://GLibUnix": { signal_add: () => 1 } })[name] });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    await flush(); assert.equal(snapshot.observation.suspended, true);
    assert.equal(snapshot.version, 2); assert.equal(snapshot.sequence, 1);
    enabled = false; tick(); await flush(); assert.equal(subscriptions.size, 0); assert.equal(snapshot.reason, "lease_inactive");
    sleeping = false; enabled = true; tick(); await flush();
    assert.equal(snapshot.observation.suspended, false); assert.equal(subscriptions.size, 8); // Includes login1 owner continuity tracking.
    const oldWatch = nextWatch; sessionId = "replacement-session"; tick(); await flush();
    assert(removedWatches.some(watch => watch.owner === ":1.20" && watch.path === "/org/gnome/Mutter/IdleMonitor/Core" && watch.id === oldWatch));
    assert(nextWatch > oldWatch); // Polling found the session boundary and rearmed the one-shot watch.
    const watchFired = [...subscriptions.values()].find(subscription => subscription.name === "org.gnome.Mutter.IdleMonitor" && subscription.signal === "WatchFired")!.fn;
    watchFired(null, ":1.20", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "WatchFired", new Variant("(u)", [nextWatch])); await flush();
    assert.equal(snapshot.activity.activitySerial, 1); // The first brief input after rearm is retained.
    const watchDuringPoll = nextWatch;
    desktopIdleMs = 300_000; deferDisplayQuery = true; tick(); await flush(); assert.equal(typeof releaseDisplayQuery, "function");
    const beforeActivityRace = snapshots.length;
    desktopIdleMs = 0;
    watchFired(null, ":1.20", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "WatchFired", new Variant("(u)", [watchDuringPoll]));
    releaseDisplayQuery!(); releaseDisplayQuery = null; await flush();
    const raceSnapshots = snapshots.slice(beforeActivityRace);
    assert.equal(raceSnapshots[0]?.activity?.inputOnly, true); // The fresh input survives while its old counter is withheld.
    assert.equal(raceSnapshots[0]?.activity?.idleMs, null);
    assert.equal(raceSnapshots.at(-1)?.activity?.activitySerial, 2);
    assert(raceSnapshots.every((entry, index) => index === 0 || entry.sequence > raceSnapshots[index - 1].sequence));
    tick(); await flush(); assert.equal(snapshot.activity.idleMs, 0); // The bounded periodic sample refreshes the counter after the input pulse.
    assert.equal(snapshot.activity.activitySerial, 2);
    const loginProperties = [...subscriptions.values()].find(subscription => subscription.name === "org.freedesktop.login1" && subscription.signal === "PropertiesChanged")!.fn;
    deferDisplayQuery = true; tick(); await flush(); assert.equal(typeof releaseDisplayQuery, "function");
    loginProperties(null, ":1.5", "/org/freedesktop/login1/session/_replacement", "org.freedesktop.DBus.Properties", "PropertiesChanged", new Variant("(sa{sv}as)", ["org.freedesktop.login1.Session", { Id: new Variant("s", "new-session") }, []]));
    releaseDisplayQuery!(); releaseDisplayQuery = null; await flush();
    assert.equal(snapshot.activity, null); assert.equal(snapshot.observation, null); assert.equal(snapshot.reason, "session_unavailable");
    loginSessionUnavailable = true; tick(); await flush();
    assert.equal(snapshot.observation, null); assert.equal(snapshot.activity, null); assert.equal(snapshot.reason, "session_unavailable");
    loginSessionUnavailable = false;
    regularLease = false; tick(); await flush();
    assert.equal(subscriptions.size, 0); assert.equal(snapshot.reason, "lease_inactive"); assert.equal(descriptors.size, 0);
});
