// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryWriter } from "../src/core/historyWriter";
import { MAX_EVENTS, mergeHistory, retain, RETENTION_MS } from "../src/core/history";
import { PresenceEngine } from "../src/core/engine";
import { UNKNOWN, type Clock, type HistoryEvent, type Snapshot } from "../src/core/types";
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

test("legacy repetitive automation decisions migrate out of the protected control partition", () => {
    const now = 2_000_000;
    const incident = [
        { ...event("desktop_inactive_for_300_seconds", now - 100), kind: "request" as const, importance: "control" as const },
        { ...event("write_failed_rule_paused", now - 99), kind: "error" as const, importance: "control" as const }
    ];
    const legacyNoise = Array.from({ length: 600 }, (_, i) => ({ ...event("automation_paused", now - 600 + i), kind: "skip" as const, importance: "control" as const }));
    const retained = retain([...incident, ...legacyNoise], now);
    assert(incident.every(row => retained.some(saved => saved.reason === row.reason)));
    assert.equal(retained.filter(row => row.reason === "automation_paused").length, 1);
    assert.equal(retained.find(row => row.reason === "automation_paused")?.repeatCount, 600);
    assert(retained.filter(row => row.reason === "automation_paused").every(row => row.importance === "detector"));
});

test("unknown untagged legacy skips keep control priority while current skips use their explicit class", () => {
    const now = 2_000_000;
    const legacyControl = { ...event("status_conflict_rule_paused", now), kind: "skip" as const };
    const currentDetector = { ...event("no_change_needed", now + 1), kind: "skip" as const, importance: "detector" as const };
    const retained = retain([legacyControl, currentDetector], now + 1);
    assert.equal(retained.find(row => row.reason === legacyControl.reason)?.importance, "control");
    assert.equal(retained.find(row => row.reason === currentDetector.reason)?.importance, "detector");
});

test("eight hours of engine decisions through HistoryWriter preserve the original write incident", async () => {
    let now = 10_000_000;
    const persisted: HistoryEvent[] = [];
    const writer = new HistoryWriter(async row => { persisted.splice(0, persisted.length, ...mergeHistory(persisted, [row], now)); }, () => now);
    const request = { ...event("desktop_inactive_for_300_seconds", now), kind: "request" as const, importance: "control" as const };
    const failure = { ...event("write_failed_rule_paused_status_updater_schema_rejected", now), kind: "error" as const, importance: "control" as const };
    writer.enqueue(request); writer.enqueue(failure); await writer.flush();

    const snapshot: Snapshot = {
        account: "synthetic", connected: true, capable: true, nativeIdleHookReady: true,
        configured: "online", effective: "online", aggregate: "online", nativeIdle: false, nativeIdleAttributed: false,
        activity: { value: "unknown", at: now, reason: "activity_provider_unavailable", scope: "synthetic desktop" },
        display: { value: "unknown", at: now, reason: "display_polling", scope: "synthetic display" },
        camera: UNKNOWN("synthetic camera")
    };
    const clock: Clock = { now: () => now, set: callback => callback, clear: () => {} };
    const engine = new PresenceEngine({ read: () => snapshot, write: async () => { throw Error("unexpected_status_write"); }, record: row => writer.enqueue(row) }, clock, { observe: true, idle: true, camera: false });
    engine.sample(); await writer.flush();

    for (let i = 0; i < 14_400; i++) {
        now += 2_000;
        snapshot.display = { ...snapshot.display, at: now, reason: `display_probe_${i}` };
        engine.sample();
        if (i % 50 === 49) await writer.flush();
    }
    await writer.flush();

    assert(persisted.some(row => row.reason === request.reason && row.kind === "request"));
    assert(persisted.some(row => row.reason === failure.reason && row.kind === "error"));
    assert(persisted.filter(row => row.importance === "control").length <= 400);
    assert(persisted.filter(row => row.importance === "detector").length <= 100);
    assert(persisted.some(row => row.kind === "skip" && row.importance === "detector"));
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
