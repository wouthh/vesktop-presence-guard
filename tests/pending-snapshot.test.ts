// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Production JavaScript tooling tested directly.
import { pendingSnapshot } from "../scripts/pending-snapshot.mjs";
test("activation snapshots reject a substituted release and remain unchanged after pending edits", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-pending-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { ledger: root, updaterPending: join(root, "pending.json") };
    writeFileSync(c.updaterPending, JSON.stringify({ release: root, marker: "validated" }));
    assert.throws(() => pendingSnapshot(c, join(root, "unexpected/dist")), /release_drift/);
    const snapshot = pendingSnapshot(c, join(root, "dist"));
    try {
        writeFileSync(c.updaterPending, JSON.stringify({ release: root, marker: "edited" }));
        assert.equal(JSON.parse(readFileSync(`/proc/self/fd/${snapshot.fd}`, "utf8")).marker, "validated");
        assert.deepEqual(readdirSync(root), ["pending.json"]);
    } finally { snapshot.close(); }
});
