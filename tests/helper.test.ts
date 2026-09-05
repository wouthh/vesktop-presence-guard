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
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        idle_add: (_: unknown, fn: () => void) => { callbacks.push(fn); }, timeout_add_seconds: () => 1, source_remove: () => { removed = true; },
        file_get_contents: () => { throw Error("parent_exited"); }
    };
    const gio = { DBus: { session: {}, system: {} }, Settings: class {}, File: { new_for_path: () => ({ replace_contents: () => { writes++; } }) }, FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 } };
    runInNewContext(source, { ARGV: ["123", "456", "/synthetic/snapshot", "/synthetic/lease"], TextDecoder, TextEncoder, require: (name: string) => ({ "gi://Gio": gio, "gi://GLib": glib, "gi://GLibUnix": { signal_add: () => 1 } })[name] });
    assert.equal(running, false); assert.equal(removed, true); assert.equal(writes, 1);
});
