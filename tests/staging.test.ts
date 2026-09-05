// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { stage, verifyStaged, hash, inventory } from "../scripts/staging.mjs";
// @ts-expect-error Installation JavaScript is linted and exercised directly.
import { restoreMain, pinBaseline, verifyWiring, planHelper, planSettings, restoreExecutables } from "../scripts/install.mjs";
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
    writeFileSync(join(ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o700, updater: 0o750 }));
    chmodSync(c.mainLauncher, 0o700); chmodSync(c.updater, 0o750);
    assert.deepEqual(pinBaseline(c), pinBaseline(c));
    assert.throws(() => verifyWiring(c), /required_updater_receipt_missing/);
    writeFileSync(join(ledger, "installed-updater.sha256"), hash("fixture"));
    verifyWiring(c);
    writeFileSync(join(ledger, "installed.json"), "{}");
    assert.throws(() => verifyWiring(c), /required_launcher_receipt_missing/);
    writeFileSync(join(ledger, "installed-launcher.sha256"), hash("fixture")); verifyWiring(c);
    chmodSync(c.mainLauncher, 0o777); assert.throws(() => verifyWiring(c), /mainLauncher_mode_drift/); chmodSync(c.mainLauncher, 0o700);
    chmodSync(c.updater, 0o777); assert.throws(() => verifyWiring(c), /updater_mode_drift/); chmodSync(c.updater, 0o750);
    const umask = process.umask(0o077);
    try { restoreExecutables(c, pinBaseline(c)); } finally { process.umask(umask); }
    assert.equal(statSync(c.mainLauncher).mode & 0o777, 0o700); assert.equal(statSync(c.updater).mode & 0o777, 0o750);
    writeFileSync(c.mainLauncher, "changed"); assert.throws(() => verifyWiring(c), /drift/);
    writeFileSync(join(ledger, "backups/updater"), "changed backup"); assert.throws(() => pinBaseline(c), /backup_drift/);
    writeFileSync(join(ledger, "backups/updater"), "fixture");
    const baselinePath = join(root, ".presence-guard/baseline.json"), originalBaseline = readFileSync(baselinePath, "utf8"), tampered = JSON.parse(originalBaseline);
    tampered.files["bundle.js"] = hash("changed"); writeFileSync(join(dist, "bundle.js"), "changed"); writeFileSync(baselinePath, JSON.stringify(tampered));
    assert.throws(() => pinBaseline(c), /baseline_anchor_drift/); writeFileSync(baselinePath, originalBaseline);
    writeFileSync(join(dist, "bundle.js"), "changed"); assert.throws(() => pinBaseline(c), /drift/);
});

test("verified rollback artifacts support reinstall using the original ledger", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), ledger: join(root, "ledger"), mainLauncher: join(root, "launcher"), updater: join(root, "updater") };
    const dist = join(root, ".wout-releases/original/dist"), native = join(c.mainProfile, "PresenceGuard");
    mkdirSync(dist, { recursive: true }); mkdirSync(native, { recursive: true }); mkdirSync(join(c.mainProfile, "settings")); mkdirSync(join(c.ledger, "backups"), { recursive: true });
    writeFileSync(join(dist, "bundle.js"), "synthetic original"); symlinkSync(dist, join(root, "dist"));
    const launcher = "#!/bin/sh\nexec mullvad-exclude flatpak run dev.vencord.Vesktop\n";
    writeFileSync(c.mainLauncher, launcher); writeFileSync(join(c.ledger, "backups/main-launcher"), launcher);
    writeFileSync(c.updater, "reviewed extension"); writeFileSync(join(c.ledger, "backups/updater"), "original updater");
    writeFileSync(join(c.ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    writeFileSync(join(c.ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o755, updater: 0o700 }));
    chmodSync(c.mainLauncher, 0o755); chmodSync(c.updater, 0o700);
    const baseline = pinBaseline(c);
    writeFileSync(join(root, ".presence-guard/display-helper.mjs"), "verified helper");
    writeFileSync(join(native, "installation.json"), JSON.stringify({ version: 1, snapshot: join(root, ".presence-guard/display.json"), welcome: false }));
    writeFileSync(join(c.ledger, "installed.json"), JSON.stringify({ helperHash: hash("verified helper") }));
    writeFileSync(join(c.ledger, "installed-launcher.sha256"), hash("previous installed launcher"));
    writeFileSync(join(c.ledger, "installed-updater.sha256"), hash("reviewed extension"));
    writeFileSync(join(c.ledger, "rolled-back.json"), JSON.stringify({ dist: baseline.dist, at: new Date(0).toISOString() }));
    writeFileSync(join(c.mainProfile, "settings/settings.json"), JSON.stringify({ plugins: { PresenceGuard: { idle: true, camera: true }, Existing: { enabled: true } } }));
    verifyWiring(c); assert(planHelper(c).launcher.includes("# PresenceGuard process-bound observer"));
    const settings = planSettings(c); assert.equal(settings.plugins.PresenceGuard.idle, false); assert.equal(settings.plugins.PresenceGuard.camera, false); assert.equal(settings.plugins.Existing.enabled, true);
    assert.equal(readFileSync(join(root, ".presence-guard/display-helper.mjs"), "utf8"), "verified helper");
});
for (const kind of ["fifo", "symlink"]) test(`wiring rejects ${kind} executables and receipts without blocking or following them`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-wiring-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, ledger: join(root, "ledger"), mainLauncher: join(root, "launcher"), updater: join(root, "updater") };
    mkdirSync(join(c.ledger, "backups"), { recursive: true });
    for (const [path, backup] of [[c.mainLauncher, "main-launcher"], [c.updater, "updater"]]) { writeFileSync(path, "fixture", { mode: 0o700 }); writeFileSync(join(c.ledger, "backups", backup), "fixture"); }
    writeFileSync(join(c.ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    writeFileSync(join(c.ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o700, updater: 0o700 }));
    writeFileSync(join(c.ledger, "installed.json"), "{}");
    const receipts = ["installed-launcher.sha256", "installed-updater.sha256"].map(name => join(c.ledger, name));
    for (const path of receipts) writeFileSync(path, hash("fixture"), { mode: 0o600 });
    verifyWiring(c);
    const module = pathToFileURL(resolve("scripts/install.mjs")).href;
    const script = `import { verifyWiring } from ${JSON.stringify(module)}; try { verifyWiring(JSON.parse(process.argv[1])); process.exitCode=1; } catch(e) { if(!/unsafe_regular_file|ELOOP/.test(e.message)) throw e; }`;
    for (const path of [c.mainLauncher, c.updater, ...receipts]) {
        const bytes = readFileSync(path), mode = statSync(path).mode & 0o777;
        unlinkSync(path);
        if (kind === "fifo") execFileSync("mkfifo", [path]);
        else { const copy = join(root, "same-bytes"); writeFileSync(copy, bytes); symlinkSync(copy, path); }
        execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(c)], { timeout: 3000, stdio: "pipe" });
        unlinkSync(path); writeFileSync(path, bytes, { mode }); verifyWiring(c);
    }
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
    const marker = join(root, "src/userplugins/presenceGuard/.presence-guard-stage.json"), before = readFileSync(marker, "utf8");
    assert.throws(() => execFileSync(process.execPath, ["scripts/install.mjs", "stage", "--config", config, "--locked"], { stdio: "pipe" }), /updater_lock_not_held/);
    assert.equal(readFileSync(marker, "utf8"), before);
});

for (const kind of ["fifo", "symlink"]) test(`staging rejects ${kind} markers and receipts without blocking`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-stage-metadata-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project"), vc = join(root, "vencord");
    mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(vc);
    writeFileSync(join(project, "src/buildInfo.ts"), "export const BUILD_INFO = {};\n");
    for (const path of [project, vc]) execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", project, "add", "."]); execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const staged = stage(project, vc), module = pathToFileURL(resolve("scripts/staging.mjs")).href;
    const script = `import { stage, verifyStaged } from ${JSON.stringify(module)}; try { const [action,project,vc,destination,commit]=process.argv.slice(1); if(action==='verify') verifyStaged(project,destination,commit); else stage(project,vc); process.exitCode=1; } catch(e) { if(!/unsafe_regular_file|ELOOP|receipt_symlink/.test(e.message)) throw e; }`;
    for (const path of [join(staged.destination, ".presence-guard-stage.json"), join(vc, ".git/presence-guard-stage.json")]) {
        const bytes = readFileSync(path); unlinkSync(path);
        if (kind === "fifo") execFileSync("mkfifo", [path]);
        else { const copy = join(root, "metadata-copy"); writeFileSync(copy, bytes); symlinkSync(copy, path); }
        const actions = path.includes("/.git/") ? ["stage"] : ["stage", "verify"];
        for (const action of actions) execFileSync(process.execPath, ["--input-type=module", "-e", script, action, project, vc, staged.destination, staged.commit], { timeout: 3000, stdio: "pipe" });
        unlinkSync(path); writeFileSync(path, bytes, { mode: 0o600 }); assert.deepEqual(stage(project, vc), staged);
    }
});
for (const kind of ["changed", "mode", "symlink", "missing-receipt"]) test(`prepare rejects ${kind} updater before staging or execution`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-prepare-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, mainProfile: join(root, "main"), altProfile: join(root, "alt"), ledger: join(root, "ledger"), mainLauncher: join(root, "launcher"), updater: join(root, "updater"), updaterLock: join(root, "runtime/lock") };
    mkdirSync(c.mainProfile); mkdirSync(c.altProfile); mkdirSync(join(c.ledger, "backups"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(c.mainProfile, "state.json"), JSON.stringify({ vencordDir: join(root, "dist") }));
    // An executed fixture must fail visibly; no host updater is used.
    for (const [path, backup] of [[c.mainLauncher, "main-launcher"], [c.updater, "updater"]]) { writeFileSync(path, "#!/bin/sh\necho UNEXPECTED_EXECUTION >&2\nexit 42\n", { mode: 0o700 }); writeFileSync(join(c.ledger, "backups", backup), readFileSync(path)); }
    writeFileSync(join(c.ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    writeFileSync(join(c.ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o700, updater: 0o700 }));
    const receipt = join(c.ledger, "installed-updater.sha256"); writeFileSync(receipt, hash(readFileSync(c.updater)));
    const config = join(root, "private.json"); writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
    if (kind === "changed") writeFileSync(c.updater, readFileSync(c.updater, "utf8") + "# drift\n");
    if (kind === "mode") chmodSync(c.updater, 0o777);
    if (kind === "symlink") { const copy = join(root, "updater-copy"); writeFileSync(copy, readFileSync(c.updater), { mode: 0o700 }); unlinkSync(c.updater); symlinkSync(copy, c.updater); }
    if (kind === "missing-receipt") unlinkSync(receipt);
    for (const flags of [[], ["--dry-run"]]) assert.throws(() => execFileSync(process.execPath, ["scripts/install.mjs", "prepare", "--config", config, ...flags], { timeout: 5000, stdio: "pipe" }), /updater_drift|updater_mode_drift|ELOOP|required_updater_receipt_missing/);
    assert.throws(() => statSync(join(root, "src/userplugins/presenceGuard")), /ENOENT/);
});

test("release inventory accepts bounded source maps larger than metadata", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-inventory-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.alloc(5 * 1024 * 1024, 32); writeFileSync(join(root, "renderer.js.map"), bytes);
    assert.deepEqual(inventory(root), { "renderer.js.map": hash(bytes) });
});
