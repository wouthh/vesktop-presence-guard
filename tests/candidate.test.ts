// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Production JavaScript tooling is linted and tested directly.
import { candidateDist } from "../scripts/install.mjs";
// @ts-expect-error Production JavaScript tooling is linted and tested directly.
import { inventory } from "../scripts/staging.mjs";
test("candidate selection verifies bundle hashes and requires an active match without a pending release", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-candidate-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, ledger: join(root, "ledger"), updaterPending: join(root, "pending.json") }, commit = "a".repeat(40);
    const before = join(root, ".wout-releases/before/dist"), after = join(root, ".wout-releases/after/dist");
    mkdirSync(before, { recursive: true }); mkdirSync(after, { recursive: true }); mkdirSync(c.ledger); symlinkSync(before, join(root, "dist"));
    for (const name of ["vencordDesktopMain.js", "vencordDesktopRenderer.js"]) writeFileSync(join(after, name), `PresenceGuard ${commit}`);
    writeFileSync(join(dirname(after), "manifest.json"), JSON.stringify({ bundle_hashes: inventory(after) }));
    writeFileSync(c.updaterPending, JSON.stringify({ release: dirname(after) })); assert.equal(candidateDist(c, commit), after);
    writeFileSync(join(after, "unexpected.js"), "drift"); assert.throws(() => candidateDist(c, commit), /hash_mismatch/); unlinkSync(join(after, "unexpected.js"));
    unlinkSync(c.updaterPending); writeFileSync(join(c.ledger, "installed.json"), JSON.stringify({ commit, dist: after }));
    assert.throws(() => candidateDist(c, commit), /pending_candidate_required/);
    unlinkSync(join(root, "dist")); symlinkSync(after, join(root, "dist")); assert.equal(candidateDist(c, commit), after);
});
