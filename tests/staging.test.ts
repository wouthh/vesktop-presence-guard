// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { stage, verifyStaged, hash } from "../scripts/staging.mjs";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { restoreMain, pinBaseline, verifyWiring } from "../scripts/install.mjs";
import { leaseActive, startIdentity } from "../helper/lifetime";

test("actual staging dry run, repeat install and drift rejection preserve other plugins", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project"), vc = join(root, "vencord"); mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(vc, "src/userplugins/existing"), { recursive: true });
    writeFileSync(join(project, "src/buildInfo.ts"), "export const BUILD_INFO = {};\n"); writeFileSync(join(vc, "src/userplugins/existing/private.txt"), "synthetic unrelated plugin");
    execFileSync("git", ["init", "-q", vc]);
    execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "."]); execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const dry = stage(project, vc, true); assert.equal(dry.files, 1); assert.throws(() => readFileSync(join(dry.destination, "buildInfo.ts")));
    const a = stage(project, vc), b = stage(project, vc); assert.deepEqual(a, b);
    verifyStaged(project, a.destination, a.commit);
    const receipt = join(vc, ".git/presence-guard-stage.json"), beforeReceipt = readFileSync(receipt, "utf8");
    const beforeTree = readFileSync(join(a.destination, "buildInfo.ts"), "utf8");
    chmodSync(receipt, 0o400); writeFileSync(join(project, "src/new.ts"), "// next reviewed source\n");
    assert.throws(() => stage(project, vc), /receipt_not_writable/);
    assert.equal(readFileSync(receipt, "utf8"), beforeReceipt); assert.equal(readFileSync(join(a.destination, "buildInfo.ts"), "utf8"), beforeTree);
    assert.throws(() => readFileSync(join(a.destination, "new.ts"))); chmodSync(receipt, 0o600); rmSync(join(project, "src/new.ts"));
    const manifestPath = join(a.destination, ".presence-guard-stage.json"), markerBytes = readFileSync(manifestPath, "utf8"), manifest = JSON.parse(markerBytes);
    const original = readFileSync(join(a.destination, "buildInfo.ts"), "utf8");
    writeFileSync(join(a.destination, "buildInfo.ts"), "tampered"); manifest.files["buildInfo.ts"] = hash("tampered"); writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyStaged(project, a.destination, a.commit), /not_canonical/);
    assert.throws(() => stage(project, vc), /receipt_drift/); assert.equal(readFileSync(join(a.destination, "buildInfo.ts"), "utf8"), "tampered");
    writeFileSync(join(a.destination, "buildInfo.ts"), original); manifest.files["buildInfo.ts"] = hash(original); writeFileSync(manifestPath, markerBytes); assert.equal(readFileSync(join(vc, "src/userplugins/existing/private.txt"), "utf8"), "synthetic unrelated plugin");
    writeFileSync(join(a.destination, "unexpected.txt"), "do not overwrite"); assert.throws(() => stage(project, vc), /drift/); assert.equal(readFileSync(join(a.destination, "unexpected.txt"), "utf8"), "do not overwrite");
});
test("rollback settings only restore the owned entry and are repeatable", () => {
    const before = { plugins: { Existing: { enabled: true } } };
    const current = { plugins: { Existing: { enabled: false, changed: true }, PresenceGuard: { enabled: true } }, unrelated: "new" };
    const restored = restoreMain(current, before); assert.deepEqual(restored, { plugins: { Existing: current.plugins.Existing }, unrelated: "new" }); assert.deepEqual(restoreMain(restored, before), restored);
});
test("baseline pinning and wiring validation reject changed files", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const dist = join(root, ".wout-releases/original/dist"), ledger = join(root, "ledger"); mkdirSync(dist, { recursive: true }); mkdirSync(join(ledger, "backups"), { recursive: true }); writeFileSync(join(dist, "bundle.js"), "synthetic bundle"); symlinkSync(dist, join(root, "dist"));
    const c = { vencordRoot: root, ledger, mainLauncher: join(root, "launcher"), updater: join(root, "updater") };
    for (const [path, backup] of [[c.mainLauncher, "main-launcher"], [c.updater, "updater"]]) { writeFileSync(path, "fixture"); writeFileSync(join(ledger, "backups", backup), "fixture"); }
    writeFileSync(join(ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    assert.deepEqual(pinBaseline(c), pinBaseline(c)); verifyWiring(c); writeFileSync(c.mainLauncher, "changed"); assert.throws(() => verifyWiring(c), /drift/);
    writeFileSync(join(ledger, "backups/updater"), "changed backup"); assert.throws(() => pinBaseline(c), /backup_drift/);
    writeFileSync(join(ledger, "backups/updater"), "fixture");
    writeFileSync(join(dist, "bundle.js"), "changed"); assert.throws(() => pinBaseline(c), /drift/);
});
test("helper lease expires, rejects future/malformed data, and identity handles spaced process names", () => {
    assert(leaseActive({ enabled: true, at: 100 }, 101)); assert.equal(leaseActive({ enabled: true, at: 102 }, 101), false);
    for (const v of [null, {}, { enabled: false, at: 100 }, { enabled: true, at: 0 }]) assert.equal(leaseActive(v, 10100), false);
    assert.equal(startIdentity(`123 (a process) ${Array.from({ length: 20 }, (_, i) => i === 19 ? "token" : "0").join(" ")}`), "token");
});

test("staging CLI creates an absent updater runtime directory and remains repeatable", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const mainProfile = join(root, "main"), altProfile = join(root, "alt"); mkdirSync(mainProfile); mkdirSync(altProfile);
    writeFileSync(join(mainProfile, "state.json"), JSON.stringify({ vencordDir: join(root, "dist") }));
    const c = { vencordRoot: root, mainProfile, altProfile, mainLauncher: join(root, "launcher"), updater: join(root, "updater"), ledger: join(root, "ledger"), updaterLock: join(root, "runtime/lock") };
    execFileSync("git", ["init", "-q", root]);
    const config = join(root, "private.json"); writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, ["scripts/install.mjs", "stage", "--config", config], { stdio: "pipe" });
    assert.equal(readFileSync(c.updaterLock, "utf8"), ""); assert(readFileSync(join(root, "src/userplugins/presenceGuard/.presence-guard-stage.json"), "utf8").includes('"version": 1'));
});
