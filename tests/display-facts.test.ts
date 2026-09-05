// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { displayFacts, describeDisplayFacts } from "../src/core/displayFacts";
const facts = { power: 3, locked: true, shieldActive: true, suspended: false, idleThresholdReached: true, thresholdMs: 300000, monitors: 1 };
test("display fact normalization drops identifiers and rejects malformed observations", () => {
    assert.deepEqual(displayFacts({ ...facts, session: "synthetic identifier", connector: "synthetic serial" }), facts);
    for (const value of [null, {}, { ...facts, power: -1 }, { ...facts, locked: "false" }, { ...facts, monitors: 0 }, { ...facts, monitors: 1.5 }, { ...facts, thresholdMs: NaN }]) assert.equal(displayFacts(value), undefined);
    assert.match(describeDisplayFacts(facts), /power save/); assert.match(describeDisplayFacts(), /unavailable/);
});
test("production native history preserves display facts and strips unknown fields on a local round trip", async t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-history-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = buildSync({ entryPoints: ["src/native.ts"], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron", "@main/utils/constants"] }).outputFiles[0].text;
    const module = { exports: {} as any }, nativeRequire = createRequire(import.meta.url);
    runInNewContext(source, { module, exports: module.exports, process, Buffer, require: (name: string) => name === "@main/utils/constants" ? { DATA_DIR: root } : name === "electron" ? {} : nativeRequire(name) });
    const signal = { at: Date.now(), value: "unknown", reason: "ambiguous", scope: "synthetic" };
    const event = { at: Date.now(), kind: "observation", source: "unknown", previous: "online", status: "idle", configured: "online", aggregate: "unknown", reason: "synthetic observation", owned: false, display: { ...signal, facts: { ...facts, session: "must not persist" } }, camera: signal };
    await module.exports.appendHistory(undefined, event);
    const stored = JSON.parse(JSON.stringify(await module.exports.readHistory(undefined)));
    assert.deepEqual(stored[0].display.facts, facts); assert.equal(stored[0].configured, "online");
    assert(!readFileSync(join(root, "PresenceGuard/history.json"), "utf8").includes("must not persist"));
    await assert.rejects(module.exports.appendHistory(undefined, { ...event, display: { ...signal, facts: { ...facts, power: 9 } } }), /invalid_history_event/);
    await module.exports.appendHistory(undefined, { ...event, display: signal });
    assert.equal((await module.exports.readHistory(undefined)).length, 2);
});
