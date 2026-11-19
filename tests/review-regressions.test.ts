// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CameraTracks } from "../src/core/tracks";
// @ts-expect-error Installation JavaScript is linted and tested directly.
import { planHelper, planSettings, preflightRollback } from "../scripts/install.mjs";
import { releaseMonitoring } from "../helper/lifetime";
// @ts-expect-error Build JavaScript is linted and tested directly.
import { compileHelper } from "../scripts/helper-build.mjs";
// @ts-expect-error Integration JavaScript is linted and tested directly.
import { verifyUpstream } from "../scripts/verify-upstream.mjs";

test("camera pruning detaches listeners even when stop emits no ended event", () => {
    const listeners = new Set<() => void>();
    const track = { readyState: "live", muted: false, enabled: true, addEventListener: (_: unknown, fn: () => void) => { listeners.add(fn); }, removeEventListener: (_: unknown, fn: () => void) => { listeners.delete(fn); } };
    const tracks = new CameraTracks(() => {}); tracks.add(track); assert.equal(tracks.live, true); assert.equal(listeners.size, 1);
    track.enabled = false; assert.equal(tracks.live, false);
    track.readyState = "ended"; tracks.prune(); assert.equal(tracks.size, 0); assert.equal(listeners.size, 0);
    track.readyState = "live"; tracks.add(track); tracks.clear(); assert.equal(listeners.size, 0); assert.equal(track.readyState, "live");
});
test("helper compilation uses source even when an ignored artifact has been tampered with", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "helper")); mkdirSync(join(root, "dist")); writeFileSync(join(root, "helper/display-helper.ts"), 'export const evidence = "reviewed-source";');
    writeFileSync(join(root, "dist/display-helper.mjs"), 'throw Error("unexpected-artifact");');
    const helper = compileHelper(root).toString(); assert(helper.includes("reviewed-source")); assert(!helper.includes("unexpected-artifact"));
});
test("integration rejects dirty tracked content and unrelated ignored plugins without deleting them", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    writeFileSync(join(root, ".gitignore"), "src/userplugins/\n"); writeFileSync(join(root, "upstream.ts"), "original"); git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"); const head = git("rev-parse", "HEAD");
    verifyUpstream(root, head); writeFileSync(join(root, "upstream.ts"), "changed"); assert.throws(() => verifyUpstream(root, head), /dirty/); assert.equal(readFileSync(join(root, "upstream.ts"), "utf8"), "changed");
    writeFileSync(join(root, "upstream.ts"), "original"); mkdirSync(join(root, "src/userplugins/unrelated"), { recursive: true }); assert.throws(() => verifyUpstream(root, head), /unrelated/);
});

test("settings preflight rejects malformed and read-only files without mutating them", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "settings")); const path = join(root, "settings/settings.json");
    writeFileSync(path, "{"); assert.throws(() => planSettings({ mainProfile: root })); assert.equal(readFileSync(path, "utf8"), "{");
    const valid = JSON.stringify({ plugins: { Existing: { enabled: true } } }); writeFileSync(path, valid); chmodSync(path, 0o400);
    assert.throws(() => planSettings({ mainProfile: root }), /writable/); assert.equal(readFileSync(path, "utf8"), valid);
});

test("rollback preflight rejects replaced targets before any release mutation", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), ledger: join(root, "ledger") };
    mkdirSync(join(c.mainProfile, "settings"), { recursive: true }); mkdirSync(join(c.mainProfile, "PresenceGuard")); mkdirSync(c.ledger);
    const settings = join(c.mainProfile, "settings/settings.json"), lease = join(c.mainProfile, "PresenceGuard/lease.json");
    writeFileSync(settings, JSON.stringify({ plugins: {} }));
    preflightRollback(c); symlinkSync(settings, lease); assert.throws(() => preflightRollback(c), /unsafe_target_file/); unlinkSync(lease);
    chmodSync(join(c.mainProfile, "settings"), 0o500); assert.throws(() => preflightRollback(c), /unsafe_target_parent/); chmodSync(join(c.mainProfile, "settings"), 0o700);
});

test("first install rejects an unsafe installation receipt without changing any integration", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), ledger: join(root, "ledger") };
    mkdirSync(c.mainProfile); mkdirSync(c.ledger);
    const receipt = join(c.ledger, "installed.json");
    mkdirSync(receipt); assert.throws(() => planHelper(c), /unsafe_target_file/); rmSync(receipt, { recursive: true });
    symlinkSync(join(root, "other"), receipt); assert.throws(() => planHelper(c), /unsafe_target_file/); unlinkSync(receipt);
    writeFileSync(receipt, "{}", { mode: 0o400 }); assert.throws(() => planHelper(c), /target_not_writable/);
    assert.deepEqual(readdirSync(c.mainProfile), []);
});

test("releasing monitoring unsubscribes despite failed snapshot storage", () => {
    const subscriptions = new Set([1, 2, 3]); let attempts = 0;
    releaseMonitoring(() => { attempts++; throw Error("read_only_storage"); }, () => subscriptions.clear());
    assert.equal(attempts, 1); assert.equal(subscriptions.size, 0);
});

test("update rejects a missing installed helper or configuration before mutation", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), ledger: join(root, "ledger") };
    mkdirSync(join(c.mainProfile, "PresenceGuard"), { recursive: true }); mkdirSync(c.ledger);
    writeFileSync(join(c.ledger, "installed.json"), JSON.stringify({ helperHash: "synthetic" }));
    assert.throws(() => planHelper(c), /configuration_missing/);
    const config = join(c.mainProfile, "PresenceGuard/installation.json");
    writeFileSync(config, JSON.stringify({ version: 1, snapshot: join(root, ".presence-guard/display.json") }));
    assert.throws(() => planHelper(c), /installed_helper_drift/);
    assert.deepEqual(readdirSync(c.mainProfile), ["PresenceGuard"]);
});

test("orphaned configuration and unsafe helper logs or directories stop first installation", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), ledger: join(root, "ledger") };
    const native = join(c.mainProfile, "PresenceGuard"), config = join(native, "installation.json"), log = join(native, "helper.log");
    mkdirSync(native, { recursive: true }); mkdirSync(c.ledger); writeFileSync(join(root, "other"), "synthetic");
    writeFileSync(config, JSON.stringify({ version: 1, snapshot: join(root, ".presence-guard/display.json"), welcome: false }));
    assert.throws(() => planHelper(c), /unowned_helper_configuration/); unlinkSync(config);
    mkdirSync(log); assert.throws(() => planHelper(c), /unsafe_target_file/); rmSync(log, { recursive: true });
    symlinkSync(join(root, "other"), log); assert.throws(() => planHelper(c), /unsafe_target_file/); unlinkSync(log);
    writeFileSync(log, "", { mode: 0o400 }); assert.throws(() => planHelper(c), /target_not_writable/); unlinkSync(log);
    mkdirSync(join(root, ".presence-guard"));
    for (const path of ["helper.log", "lease.json", "history.json", "diagnostics.json"].map(name => join(native, name)).concat(join(root, ".presence-guard/display.json"))) {
        writeFileSync(path, "synthetic unrelated contents");
        assert.throws(() => planHelper(c), /unowned_runtime_artifact/);
        assert.equal(readFileSync(path, "utf8"), "synthetic unrelated contents"); unlinkSync(path);
    }
    const lease = join(native, "lease.json");
    mkdirSync(lease); assert.throws(() => planHelper(c), /unsafe_target_file/); rmSync(lease, { recursive: true });
    symlinkSync(join(root, "other"), lease); assert.throws(() => planHelper(c), /unsafe_target_file/); unlinkSync(lease);
    rmSync(native, { recursive: true }); symlinkSync(join(root, "missing"), native);
    assert.throws(() => planHelper(c), /helper_directory_drift/);
});
