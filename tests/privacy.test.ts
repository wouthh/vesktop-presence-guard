// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const scanner = resolve("scripts/privacy.mjs");
for (const directory of [".cache", "dist", "node_modules"]) test(`privacy gate rejects force-added artifacts in ${directory}`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-privacy-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, ".gitignore"), `${directory}/\n`);
    mkdirSync(join(root, directory));
    const path = join(directory, "synthetic-private.txt");
    writeFileSync(join(root, path), "ghp_" + "x".repeat(32));
    const scan = () => execFileSync(process.execPath, [scanner], { cwd: root, stdio: "pipe" });
    scan(); // Ignored, untracked runtime data is not a publication input.
    execFileSync("git", ["-C", root, "add", "--force", path]);
    assert.throws(scan, /artifact cannot be published/);
});
test("privacy gate rejects the stored target of a tracked symlink", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-privacy-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", root]);
    const harmless = join(root, "ordinary.txt"); writeFileSync(harmless, "harmless contents");
    symlinkSync(harmless, join(root, "link")); execFileSync("git", ["-C", root, "add", "link"]);
    assert.throws(() => execFileSync(process.execPath, [scanner], { cwd: root, stdio: "pipe" }), /non-regular source/);
    unlinkSync(join(root, "link")); writeFileSync(join(root, "link"), "harmless replacement");
    assert.throws(() => execFileSync(process.execPath, [scanner], { cwd: root, stdio: "pipe" }), /non-regular source/);
});
for (const privateCopy of ["index", "working"]) test(`privacy gate checks the ${privateCopy} copy despite a harmless other copy`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-privacy-"));
    t.after(() => rmSync(root, { recursive: true, force: true })); execFileSync("git", ["init", "-q", root]);
    const path = join(root, "source.txt"), secret = "ghp_" + "x".repeat(32);
    writeFileSync(path, privateCopy === "index" ? secret : "harmless");
    execFileSync("git", ["-C", root, "add", "source.txt"]);
    writeFileSync(path, privateCopy === "index" ? "harmless" : secret);
    assert.throws(() => execFileSync(process.execPath, [scanner], { cwd: root, stdio: "pipe" }), /privacy pattern/);
});
