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
test("unsupported launcher is rejected by non-mutating preflight", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "main")); mkdirSync(join(root, "ledger"));
    const launcher = join(root, "launcher"); writeFileSync(launcher, "#!/bin/sh\nexec unsupported-launcher\n");
    const before = readdirSync(root);
    assert.throws(() => planHelper({ vencordRoot: root, mainProfile: join(root, "main"), mainLauncher: launcher, ledger: join(root, "ledger") }), /unsupported_launcher/);
    assert.deepEqual(readdirSync(root), before); assert.equal(readFileSync(launcher, "utf8"), "#!/bin/sh\nexec unsupported-launcher\n");
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
    const c = { vencordRoot: root, mainProfile: join(root, "main"), mainLauncher: join(root, "launcher"), updater: join(root, "updater"), ledger: join(root, "ledger") };
    mkdirSync(join(c.mainProfile, "settings"), { recursive: true }); mkdirSync(join(c.mainProfile, "PresenceGuard")); mkdirSync(c.ledger);
    const settings = join(c.mainProfile, "settings/settings.json"), lease = join(c.mainProfile, "PresenceGuard/lease.json");
    writeFileSync(c.mainLauncher, "original launcher"); writeFileSync(c.updater, "original updater"); writeFileSync(settings, JSON.stringify({ plugins: {} }));
    preflightRollback(c); symlinkSync(settings, lease); assert.throws(() => preflightRollback(c), /unsafe_target_file/); unlinkSync(lease);
    chmodSync(join(c.mainProfile, "settings"), 0o500); assert.throws(() => preflightRollback(c), /unsafe_target_parent/); chmodSync(join(c.mainProfile, "settings"), 0o700);
    assert.equal(readFileSync(c.mainLauncher, "utf8"), "original launcher"); assert.equal(readFileSync(c.updater, "utf8"), "original updater");
});
