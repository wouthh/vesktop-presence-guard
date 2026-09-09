// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
// @ts-expect-error Production JavaScript tooling is linted and tested directly.
import { hash } from "../scripts/staging.mjs";

test("actual prepare CLI holds both locks during its maintained-updater build", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-prepare-"));
    t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(root + ".presence-guard-stage.lock", { force: true }); });
    const c = { vencordRoot: root, ledger: join(root, "ledger"), mainProfile: join(root, "main"), altProfile: join(root, "alt"), mainLauncher: join(root, "launcher"), updater: join(root, "updater"), updaterLock: join(root, "runtime/lock") };
    const dist = join(root, ".wout-releases/baseline/dist");
    for (const path of [dist, c.mainProfile, c.altProfile, join(c.ledger, "backups"), join(root, "src/userplugins/Existing")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(dist, "bundle.js"), "synthetic original"); symlinkSync(dist, join(root, "dist"));
    writeFileSync(join(c.mainProfile, "state.json"), JSON.stringify({ vencordDir: join(root, "dist") }));
    writeFileSync(join(root, "src/userplugins/Existing/index.ts"), "// synthetic existing plugin");
    const updater = `#!/bin/sh\nset -eu\nif /usr/bin/flock -n '${c.updaterLock}' /usr/bin/true; then exit 23; fi\nif /usr/bin/flock -n '${root}.presence-guard-stage.lock' /usr/bin/true; then exit 24; fi\nprintf 'both locks held' > '${root}/build-evidence'\n`;
    for (const [path, name, bytes] of [[c.mainLauncher, "main-launcher", "synthetic launcher"], [c.updater, "updater", updater]]) { writeFileSync(path, bytes, { mode: 0o700 }); writeFileSync(join(c.ledger, "backups", name), bytes, { mode: 0o600 }); }
    writeFileSync(join(c.ledger, "installed-updater.sha256"), hash(updater), { mode: 0o600 });
    writeFileSync(join(c.ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o700, updater: 0o700 }));
    writeFileSync(join(c.ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    const config = join(root, "installation.json"); writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
    execFileSync("git", ["init", "-q", root]);
    execFileSync(process.execPath, [resolve("scripts/install.mjs"), "prepare", "--config", config], { timeout: 15000, stdio: "pipe" });
    assert.equal(readFileSync(join(root, "build-evidence"), "utf8"), "both locks held");
    assert.equal(readFileSync(join(root, "src/userplugins/Existing/index.ts"), "utf8"), "// synthetic existing plugin");
    const publication = join(c.ledger, "baseline.sha256.publication");
    writeFileSync(publication, "{", { mode: 0o600 });
    assert.throws(() => execFileSync(process.execPath, [resolve("scripts/install.mjs"), "prepare", "--dry-run", "--config", config], { timeout: 5000, stdio: "pipe" }), /baseline_publication_recovery_required/);
    assert.equal(readFileSync(publication, "utf8"), "{"); assert.equal(existsSync(join(root, ".presence-guard")), false);
});
