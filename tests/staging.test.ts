// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { stage } from "../scripts/staging.mjs";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { restoreMain, pinBaseline, verifyWiring } from "../scripts/install.mjs";
import { leaseActive, startIdentity } from "../helper/lifetime";

test("actual staging dry run, repeat install and drift rejection preserve other plugins", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project"), vc = join(root, "vencord"); mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(vc, "src/userplugins/existing"), { recursive: true });
    writeFileSync(join(project, "src/buildInfo.ts"), "export const BUILD_INFO = {};\n"); writeFileSync(join(vc, "src/userplugins/existing/private.txt"), "synthetic unrelated plugin");
    execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "."]); execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const dry = stage(project, vc, true); assert.equal(dry.files, 1); assert.throws(() => readFileSync(join(dry.destination, "buildInfo.ts")));
    const a = stage(project, vc), b = stage(project, vc); assert.deepEqual(a, b); assert.equal(readFileSync(join(vc, "src/userplugins/existing/private.txt"), "utf8"), "synthetic unrelated plugin");
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
    assert.deepEqual(pinBaseline(c), pinBaseline(c)); verifyWiring(c); writeFileSync(c.mainLauncher, "changed"); assert.throws(() => verifyWiring(c), /drift/);
    writeFileSync(join(dist, "bundle.js"), "changed"); assert.throws(() => pinBaseline(c), /drift/);
});
test("helper lease expires, rejects future/malformed data, and identity handles spaced process names", () => {
    assert(leaseActive({ enabled: true, at: 100 }, 101)); assert.equal(leaseActive({ enabled: true, at: 102 }, 101), false);
    for (const v of [null, {}, { enabled: false, at: 100 }, { enabled: true, at: 0 }]) assert.equal(leaseActive(v, 10100), false);
    assert.equal(startIdentity(`123 (a process) ${Array.from({ length: 20 }, (_, i) => i === 19 ? "token" : "0").join(" ")}`), "token");
});
