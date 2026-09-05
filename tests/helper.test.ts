// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

test("production helper enters its loop before quitting for an already-exited parent", () => {
    const source = buildSync({ entryPoints: ["helper/display-helper.ts"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["gi://Gio", "gi://GLib", "gi://GLibUnix"] }).outputFiles[0].text;
    const callbacks: (() => void)[] = []; let running = false; let writes = 0; let removed = false;
    const glib = {
        MainLoop: class { run() { running = true; for (const fn of callbacks.splice(0)) fn(); if (running) throw Error("loop_did_not_terminate"); } quit() { running = false; } },
        uuid_string_random: () => "synthetic-instance",
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        idle_add: (_: unknown, fn: () => void) => { callbacks.push(fn); }, timeout_add_seconds: () => 1, source_remove: () => { removed = true; },
        file_get_contents: () => { throw Error("parent_exited"); }
    };
    const gio = { Credentials: class { get_unix_user() { return 777; } }, DBus: { session: {}, system: {} }, Settings: class {}, File: { new_for_path: () => ({ replace_contents: () => { writes++; } }) }, FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 } };
    runInNewContext(source, { ARGV: ["123", "456", "/synthetic/snapshot", "/synthetic/lease"], TextDecoder, TextEncoder, require: (name: string) => ({ "gi://Gio": gio, "gi://GLib": glib, "gi://GLibUnix": { signal_add: () => 1 } })[name] });
    assert.equal(running, false); assert.equal(removed, true); assert.equal(writes, 1);
});

test("production helper re-reads sleep state after a resume signal missed without a lease", async () => {
    const source = buildSync({ entryPoints: ["helper/display-helper.ts"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["gi://Gio", "gi://GLib", "gi://GLibUnix"] }).outputFiles[0].text;
    let enabled = true, sleeping = true, regularLease = true, snapshot: any, tick!: () => void;
    const idle: (() => void)[] = [], subscriptions = new Set<number>(); let next = 1;
    class Variant { constructor(_type: string, public value: any) {} deepUnpack() { return this.value; } }
    const bus = {
        call: (_name: string, _path: string, _iface: string, method: string, params: Variant | null, _reply: unknown, _flags: unknown, _timeout: unknown, _cancel: unknown, callback: (bus: unknown, result: unknown) => void) => {
            const value = method === "GetAll" ? [Object.fromEntries(Object.entries({ User: [777, "/synthetic/user"], Active: true, Type: "wayland", Class: "user", LockedHint: false, Id: "synthetic-session" }).map(([key, value]) => [key, new Variant("v", value)]))] : method === "Get" ? [new Variant("v", params?.value[1] === "PreparingForSleep" ? sleeping : 0)]
                : method === "GetCurrentState" ? [0, [], [[0, 0, 1, 0, false, ["synthetic"]]]]
                    : method === "GetActive" ? [false] : method === "GetNameOwner" ? ["synthetic-provider"] : [0];
            queueMicrotask(() => callback(null, { deepUnpack: () => value }));
        },
        call_finish: (result: unknown) => result,
        signal_subscribe: () => { const id = next++; subscriptions.add(id); return id; },
        signal_unsubscribe: (id: number) => subscriptions.delete(id)
    };
    const glib = {
        Variant, uuid_string_random: () => "synthetic-instance", PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        MainLoop: class { run() { for (const fn of idle.splice(0)) fn(); } quit() {} },
        idle_add: (_: unknown, fn: () => void) => idle.push(fn), timeout_add_seconds: (_: unknown, _seconds: number, fn: () => void) => { tick = fn; return 1; }, source_remove: () => {},
        file_get_contents: (path: string) => { assert(path.startsWith("/proc/") || regularLease, "must not open a non-regular lease"); return [true, new TextEncoder().encode(path.startsWith("/proc/") ? `123 (synthetic) ${Array.from({ length: 20 }, (_, i) => i === 19 ? "456" : "0").join(" ")}` : JSON.stringify({ enabled, at: Date.now() }))]; }
    };
    const gio = { Credentials: class { get_unix_user() { return 777; } }, DBus: { session: bus, system: bus }, DBusCallFlags: { NO_AUTO_START: 1 }, DBusSignalFlags: { NONE: 0 }, Settings: class { get_uint() { return 300; } }, FileType: { REGULAR: 1 }, FileQueryInfoFlags: { NOFOLLOW_SYMLINKS: 1 }, File: { new_for_path: (path: string) => ({ query_info: () => ({ get_file_type: () => path.startsWith("/proc/") || regularLease ? 1 : 4, get_size: () => 0 }), replace_contents: (bytes: Uint8Array) => { snapshot = JSON.parse(new TextDecoder().decode(bytes)); } }) }, FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 } };
    runInNewContext(source, { ARGV: ["123", "456", "/synthetic/snapshot", "/synthetic/lease"], TextDecoder, TextEncoder, require: (name: string) => ({ "gi://Gio": gio, "gi://GLib": glib, "gi://GLibUnix": { signal_add: () => 1 } })[name] });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    await flush(); assert.equal(snapshot.observation.suspended, true);
    enabled = false; tick(); await flush(); assert.equal(subscriptions.size, 0); assert.equal(snapshot.reason, "lease_inactive");
    sleeping = false; enabled = true; tick(); await flush();
    assert.equal(snapshot.observation.suspended, false); assert.equal(subscriptions.size, 5);
    regularLease = false; tick(); await flush();
    assert.equal(subscriptions.size, 0); assert.equal(snapshot.reason, "lease_inactive");
});
