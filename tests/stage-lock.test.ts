// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error JavaScript tooling is linted and exercised directly.
import { stageLock } from "../scripts/locked-stage.mjs";
test("integration and installation staging share one per-root exclusive lock", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-stage-lock-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const vc = join(root, "vencord"); mkdirSync(vc); execFileSync("git", ["init", "-q", vc]);
    const lock = stageLock(vc), module = pathToFileURL(resolve("scripts/locked-stage.mjs")).href;
    const script = `import assert from 'node:assert/strict'; import {lockedStage} from ${JSON.stringify(module)}; assert.throws(()=>lockedStage(process.cwd(),process.argv[1]));`;
    execFileSync("/usr/bin/flock", ["--no-fork", "-n", lock, process.execPath, "--input-type=module", "-e", script, vc], { timeout: 5000, stdio: "pipe" });
    assert.equal(existsSync(join(vc, "src/userplugins/presenceGuard")), false);
    assert.throws(() => execFileSync(process.execPath, ["scripts/locked-stage.mjs", process.cwd(), vc, "write"], { timeout: 5000, stdio: "pipe" }), /staging_lock_not_held/);
});
