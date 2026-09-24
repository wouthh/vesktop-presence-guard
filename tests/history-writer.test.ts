// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryWriter } from "../src/core/historyWriter";
import { MAX_EVENTS, mergeHistory, retain, RETENTION_MS } from "../src/core/history";
import { UNKNOWN, type HistoryEvent } from "../src/core/types";
const event = (reason: string, at = 100000): HistoryEvent => ({ at, reason, kind: "observation", source: "unknown", previous: "online", status: "idle", configured: "online", aggregate: "unknown", owned: false, display: UNKNOWN("synthetic"), camera: UNKNOWN("synthetic") });
test("transient append failure retains the oldest event and retries before later events", async () => {
    const attempts: string[] = [], saved: string[] = [];
    const writer = new HistoryWriter(async e => { attempts.push(e.reason); if (attempts.length === 1) throw Error("temporary_failure"); saved.push(e.reason); }, () => 100000);
    writer.enqueue(event("first")); await assert.rejects(writer.flush(), /temporary_failure/); assert.equal(writer.pendingCount, 1);
    writer.enqueue(event("second")); await writer.flush();
    assert.deepEqual(attempts, ["first", "first", "second"]); assert.deepEqual(saved, ["first", "second"]); assert.equal(writer.pendingCount, 0);
});
test("enqueuing during a detector append does not replay the in-flight summary", async () => {
    let release!: () => void; const saved: HistoryEvent[] = [];
    const writer = new HistoryWriter(async e => { saved.push(e); if (saved.length === 1) await new Promise<void>(resolve => { release = resolve; }); }, () => 100001);
    writer.enqueue(event("same_detector_reason", 100000));
    const flushing = writer.flush();
    writer.enqueue(event("same_detector_reason", 100001));
    assert.equal(writer.pendingCount, 1);
    release(); await flushing;
    assert.equal(saved.length, 2);
    assert.equal(retain(saved, 100001)[0].repeatCount, 2);
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
test("events enqueued in the clear-completion microtask remain pending", async () => {
    let startOperation!: () => void, resolveClear!: () => void;
    const started = new Promise<void>(resolve => { startOperation = resolve; });
    const saved: string[] = [];
    const writer = new HistoryWriter(async e => { saved.push(e.reason); }, () => 100000);
    const clearing = writer.clear(() => {
        startOperation();
        return new Promise<void>(resolve => { resolveClear = resolve; });
    });
    await started;
    resolveClear();
    queueMicrotask(() => writer.enqueue(event("late_clear_window")));
    await clearing;
    await writer.flush();
    assert.deepEqual(saved, ["late_clear_window"]);
    assert.equal(writer.pendingCount, 0);
});
test("failed pending history obeys the same count and time limits as retained history", async () => {
    let now = 100000, attempts = 0;
    const writer = new HistoryWriter(async () => { attempts++; throw Error("unavailable"); }, () => now);
    for (let i = 0; i < MAX_EVENTS + 10; i++) writer.enqueue(event(String(i)));
    assert.equal(writer.pendingCount, 100); await assert.rejects(writer.flush());
    now += RETENTION_MS + 1; await writer.flush(); assert.equal(writer.pendingCount, 0); assert.equal(attempts, 1);
});

test("legacy configured-status observations retain the protected control partition", () => {
    const now = 2_000_000;
    const legacyStatus = Array.from({ length: 120 }, (_, i) => ({ ...event(i % 2 ? "status_observed" : "configured_online_observed_native_idle", now - 120 + i), importance: undefined }));
    const detectorNoise = Array.from({ length: 160 }, (_, i) => ({ ...event(`legacy_detector_${i}`, now - 160 + i), importance: undefined }));
    const retained = retain([...legacyStatus, ...detectorNoise], now);
    assert.equal(retained.filter(row => row.reason === "status_observed").length, 60);
    assert.equal(retained.filter(row => row.reason === "configured_online_observed_native_idle").length, 60);
    assert.equal(retained.filter(row => row.reason.startsWith("legacy_detector_")).length, 100);
    assert(retained.filter(row => row.reason === "status_observed" || row.reason === "configured_online_observed_native_idle").every(row => row.importance === "control"));
});

test("detector cap keeps a frequently repeated cause by its latest occurrence", () => {
    const now = 2_000_000;
    const rows = [event("recently_repeated", now - 111)];
    for (let i = 0; i < 110; i++) rows.push(event(`one_off_${i}`, now - 110 + i));
    rows.push(event("recently_repeated", now - 1));
    const retained = retain(rows, now);
    const repeated = retained.find(row => row.reason === "recently_repeated");
    assert.equal(repeated?.repeatCount, 2);
    assert.equal(repeated?.at, now - 1);
    assert.equal(retained.filter(row => row.importance === "detector").length, 100);
});

test("overlapping detector summaries merge as a union without recounting a persisted prefix", () => {
    const persisted = { ...event("same_detector_reason", 100002), importance: "detector" as const, repeatCount: 2, firstAt: 100000, lastAt: 100002 };
    const current = { ...event("same_detector_reason", 100003), importance: "detector" as const, repeatCount: 3, firstAt: 100000, lastAt: 100003 };
    const merged = mergeHistory([persisted], [current], 100003);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].repeatCount, 3);
    assert.equal(merged[0].firstAt, 100000);
    assert.equal(merged[0].lastAt, 100003);
});
