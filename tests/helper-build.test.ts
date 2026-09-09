// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Production JavaScript tooling is linted and directly exercised.
import { compileHelper } from "../scripts/helper-build.mjs";
test("installed helper compilation uses committed blobs despite working-tree edits", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-helper-source-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "helper")); writeFileSync(join(root, "helper/display-helper.ts"), 'console.log("REVIEWED_SOURCE");\n');
    execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "helper/display-helper.ts"), 'console.log("UNCOMMITTED_SOURCE");\n');
    const compiled = compileHelper(root, commit).toString(); assert.match(compiled, /REVIEWED_SOURCE/); assert.doesNotMatch(compiled, /UNCOMMITTED_SOURCE/);
    symlinkSync("display-helper.ts", join(root, "helper/link.ts")); execFileSync("git", ["-C", root, "add", "helper/link.ts"]); execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "symlink fixture"]);
    const unsafe = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.throws(() => compileHelper(root, unsafe), /unsafe_helper_tree_entry/);
});

test("committed helper imports cannot pull compiler inputs from outside the authenticated snapshot", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-helper-input-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "helper")); const external = join(root, "untracked.ts"); writeFileSync(external, 'export const value="unreviewed dependency";\n');
    writeFileSync(join(root, "helper/display-helper.ts"), `import { value } from ${JSON.stringify(external)}; console.log(value);\n`);
    execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "add", "helper"]); execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.throws(() => compileHelper(root, commit), /unauthenticated_helper_dependency/);
});
