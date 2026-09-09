// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryWriter } from "../src/core/historyWriter";
import { MAX_EVENTS, RETENTION_MS } from "../src/core/history";
import { UNKNOWN, type HistoryEvent } from "../src/core/types";
const event = (reason: string, at = 100000): HistoryEvent => ({ at, reason, kind: "observation", source: "unknown", previous: "online", status: "idle", configured: "online", aggregate: "unknown", owned: false, display: UNKNOWN("synthetic"), camera: UNKNOWN("synthetic") });
test("transient append failure retains the oldest event and retries before later events", async () => {
    const attempts: string[] = [], saved: string[] = [];
    const writer = new HistoryWriter(async e => { attempts.push(e.reason); if (attempts.length === 1) throw Error("temporary_failure"); saved.push(e.reason); }, () => 100000);
    writer.enqueue(event("first")); await assert.rejects(writer.flush(), /temporary_failure/); assert.equal(writer.pendingCount, 1);
    writer.enqueue(event("second")); await writer.flush();
    assert.deepEqual(attempts, ["first", "first", "second"]); assert.deepEqual(saved, ["first", "second"]); assert.equal(writer.pendingCount, 0);
});
for (const failed of [false, true]) test(`clear ${failed ? "failure preserves" : "success removes"} older queued history while keeping new events`, async () => {
    let release!: () => void; const saved: string[] = [], attempts: string[] = [];
    const writer = new HistoryWriter(async e => { attempts.push(e.reason); if (e.reason === "first") await new Promise<void>(resolve => { release = resolve; }); saved.push(e.reason); }, () => 100000);
    writer.enqueue(event("first")); writer.enqueue(event("second")); const flushing = writer.flush();
    const clearing = writer.clear(async () => { if (failed) throw Error("clear_failed"); saved.length = 0; });
    writer.enqueue(event("new")); release(); await flushing;
    if (failed) await assert.rejects(clearing, /clear_failed/); else await clearing;
    await writer.flush();
    assert.deepEqual(saved, failed ? ["first", "second", "new"] : ["new"]);
    assert.deepEqual(attempts, failed ? ["first", "second", "new"] : ["first", "new"]); assert.equal(writer.pendingCount, 0);
});
test("failed pending history obeys the same count and time limits as retained history", async () => {
    let now = 100000, attempts = 0;
    const writer = new HistoryWriter(async () => { attempts++; throw Error("unavailable"); }, () => now);
    for (let i = 0; i < MAX_EVENTS + 10; i++) writer.enqueue(event(String(i)));
    assert.equal(writer.pendingCount, MAX_EVENTS); await assert.rejects(writer.flush());
    now += RETENTION_MS + 1; await writer.flush(); assert.equal(writer.pendingCount, 0); assert.equal(attempts, 1);
});
