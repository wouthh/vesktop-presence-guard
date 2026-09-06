// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { PresenceEngine } from "../src/core/engine";
import { DisplayDetector } from "../src/core/display";
import { clearHistoryView, loadHistoryView, mergeHistory, retain, RETENTION_MS } from "../src/core/history";
import { Provenance } from "../src/core/provenance";
import { combineCamera } from "../src/core/camera";
import { UNKNOWN } from "../src/core/types";
import type { HistoryEvent, Options, Snapshot, Status, WriteToken } from "../src/core/types";

function fixture(options: Partial<Options> = {}) {
    let now = 100000;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const s: Snapshot = { account: "synthetic", capable: true, connected: true, configured: "online", effective: "online", aggregate: "online", nativeIdle: false, display: { at: now, value: "active", reason: "active", scope: "synthetic" }, camera: { at: now, value: "inactive", reason: "clear", scope: "synthetic" } };
    const history: HistoryEvent[] = [];
    const writes: Status[] = [];
    let gate: (() => Promise<void>) | undefined;
    let ack: (() => Promise<void>) | undefined;
    const engine = new PresenceEngine({ read: () => structuredClone(s), record: e => history.push(e), write: async (token, guard) => {
        await gate?.();
        if (!guard()) return;
        writes.push(token.target);
        s.configured = s.effective = token.target;
        await ack?.();
        engine.sample("plugin", token);
    } }, { now: () => now, set: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; }, clear: id => { timers.delete(id as number); } }, { observe: true, idle: true, camera: true, ...options });
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    async function advance(ms = 2000) {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
        await flush();
    }
    function signal(display: Snapshot["display"]["value"], camera: Snapshot["camera"]["value"] = s.camera.value) { s.display = { ...s.display, value: display, at: now }; s.camera = { ...s.camera, value: camera, at: now }; engine.sample(); }
    function manual(status: Status) { engine.manual(status); s.configured = s.effective = status; engine.sample("manual"); }
    return { s, engine, history, writes, advance, signal, manual, flush, now: () => now, delayWrite: (fn: () => Promise<void>) => { gate = fn; }, delayAck: (fn: () => Promise<void>) => { ack = fn; } };
}
for (const boundary of ["reconnect", "account"]) test(`camera evidence must be observed after ${boundary}, not merely read again`, async () => {
    const f = fixture({ idle: false }); f.engine.sample();
    const captured = { ...f.s.camera, value: "active" as const };
    await f.advance(1);
    if (boundary === "account") { f.s.account = "another-synthetic"; f.engine.sample(); }
    else f.engine.boundary("reconnect");
    await f.advance(1);
    f.s.camera = combineCamera(captured, UNKNOWN("local"), f.now()); f.engine.sample();
    await f.advance(); assert.deepEqual(f.writes, []);
    f.s.camera = combineCamera({ ...captured, at: f.now() }, UNKNOWN("local"), f.now()); f.engine.sample();
    await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});
for (const unavailable of ["connected", "capable", "account"] as const) test(`${unavailable} uncertainty invalidates detector evidence even without pending ownership`, async () => {
    const f = fixture({ idle: false }); f.s.camera.value = "active";
    if (unavailable === "account") f.s.account = null; else f.s[unavailable] = false;
    f.engine.sample(); await f.advance(1);
    f.s.connected = f.s.capable = true; f.s.account = "synthetic"; f.engine.sample();
    await f.advance(); assert.deepEqual(f.writes, []);
    f.signal("active", "active"); await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});
test("observation-only never writes or acquires simulated ownership", async () => {
    const f = fixture({ idle: false, camera: false }); f.signal("inactive"); await f.advance(); f.signal("inactive", "active"); await f.advance();
    assert.deepEqual(f.writes, []); assert.equal(f.engine.ownership, null); assert(f.history.some(e => e.kind === "simulation"));
});
test("baseline records ambiguous power-save facts and native Idle separately without tick spam or writes", async () => {
    const f = fixture({ idle: false, camera: false }), detector = new DisplayDetector();
    const observation = { at: f.now(), power: 0, locked: false, shieldActive: false, suspended: false, idleMs: 298000, thresholdMs: 300000, monitors: 1, topology: "synthetic", provider: "synthetic" };
    f.s.display = detector.observe(observation); f.engine.sample();
    await f.advance(2000); Object.assign(observation, { at: f.now(), locked: true, shieldActive: true, power: 3, idleMs: 300000 });
    f.s.display = detector.observe(observation); f.engine.sample();
    assert.equal(f.s.display.value, "unknown");
    const power = f.history.find(e => e.reason === "display_facts_observed_cause_not_proven");
    assert.equal(power?.display.facts?.power, 3); assert.equal(power?.display.facts?.locked, true);
    assert.equal(power?.status, "online"); assert.equal(power?.source, "unknown");
    const count = f.history.length;
    for (let i = 0; i < 4; i++) { await f.advance(2000); Object.assign(observation, { at: f.now(), idleMs: observation.idleMs + 2000 }); f.s.display = detector.observe(observation); f.engine.sample(); }
    assert.equal(f.history.length, count);
    f.s.effective = "idle"; f.s.nativeIdle = true; f.engine.sample("native/client");
    const idle = f.history.find(e => e.reason === "configured_online_observed_native_idle");
    assert.equal(idle?.configured, "online"); assert.equal(idle?.display.facts?.power, 3);
    assert.equal(idle?.kind, "observation"); assert.equal(idle?.owned, false);
    assert.deepEqual(f.writes, []); assert(!f.history.some(e => e.kind === "request" || e.kind === "confirmation"));
});
for (const value of ["idle", "dnd", "invisible", "offline", "unknown"] as Status[]) test(`non-owned ${value} remains untouched`, async () => {
    const f = fixture(); f.s.configured = f.s.effective = value; f.signal("inactive", "active"); await f.advance(); assert.deepEqual(f.writes, []);
});
test("configured Online plus native effective Idle is not acquired", async () => {
    const f = fixture(); f.s.effective = "idle"; f.s.nativeIdle = true; f.signal("inactive"); await f.advance();
    assert.deepEqual(f.writes, []); assert(f.history.some(e => e.reason === "configured_online_observed_native_idle"));
});
test("Idle cycle restores only its own status", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); assert.equal(f.engine.ownership?.status, "idle"); f.signal("active"); await f.advance();
    assert.deepEqual(f.writes, ["idle", "online"]); assert.equal(f.engine.ownership, null);
});
test("webcam takes precedence, then inactive display retains Idle", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.signal("inactive", "active"); await f.advance(); f.signal("inactive", "inactive"); await f.advance(); f.signal("active"); await f.advance();
    assert.deepEqual(f.writes, ["idle", "dnd", "idle", "online"]);
});
test("Online camera cycle returns Online", async () => {
    const f = fixture(); f.signal("active", "active"); await f.advance(); f.signal("active", "inactive"); await f.advance(); assert.deepEqual(f.writes, ["dnd", "online"]);
});
for (const owned of ["idle", "dnd"] as const) for (const manual of ["idle", "dnd", "invisible"] as const) test(`${owned} revoked by manual ${manual}, including same value`, async () => {
    const f = fixture(); f.signal("inactive", owned === "dnd" ? "active" : "inactive"); await f.advance(); f.manual(manual); f.signal("active", "inactive"); await f.advance();
    assert.deepEqual(f.writes, [owned]); assert.equal(f.s.effective, manual); assert.equal(f.engine.ownership, null);
});
test("same-value duration selection revokes ownership", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.engine.manual("idle"); f.signal("active"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
});
test("manual intervention cancels debounce", async () => {
    const f = fixture(); f.signal("inactive"); f.manual("invisible"); await f.advance(); assert.deepEqual(f.writes, []);
});
test("manual intervention while settings load awaits cancels actual mutation", async () => {
    const f = fixture(); let release!: () => void; f.delayWrite(() => new Promise(r => { release = r; })); f.signal("inactive"); await f.advance(); f.manual("dnd"); release(); await f.flush(); assert.deepEqual(f.writes, []);
});
test("late acknowledgement cannot resurrect ownership", async () => {
    const f = fixture(); let release!: () => void; f.delayAck(() => new Promise(r => { release = r; })); f.signal("inactive"); await f.advance(); f.manual("idle"); release(); await f.flush(); f.signal("active"); await f.advance(); assert.equal(f.engine.ownership, null); assert.deepEqual(f.writes, ["idle"]);
});
test("manual Online allows only fresh evaluation", async () => {
    const f = fixture(); f.signal("inactive"); f.manual("online"); f.signal("active"); await f.advance(); assert.deepEqual(f.writes, []); f.signal("inactive"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
});
test("Unknown camera or display never releases owned status", async () => {
    const f = fixture(); f.signal("active", "active"); await f.advance(); f.signal("active", "unknown"); await f.advance(); f.signal("unknown", "inactive"); await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});
test("stale detector cannot authorize a scheduled write", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(11000); assert.deepEqual(f.writes, []);
});
test("native Idle prevents a false Online restoration", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.s.nativeIdle = true; f.signal("active"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
});
for (const boundary of ["reconnect", "restart", "logout"]) test(`${boundary} discards ownership`, async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.engine.boundary(boundary); f.signal("active"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
});
test("account change and connection loss invalidate pending actions", async () => {
    for (const change of [(s: Snapshot) => { s.account = "another-synthetic"; }, (s: Snapshot) => { s.connected = false; }]) {
        const f = fixture(); f.signal("inactive"); change(f.s); f.engine.sample(); await f.advance(); assert.deepEqual(f.writes, []);
    }
});
test("disable owning rule and stop leave status untouched", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.engine.configure({ observe: true, idle: false, camera: true }); f.signal("active"); await f.advance(); f.engine.stop(); assert.deepEqual(f.writes, ["idle"]); assert.equal(f.engine.ownership, null);
});
test("external same-value writes revoke and pause; native reversal is not fought", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); f.engine.external("external"); f.s.configured = f.s.effective = "online"; f.signal("inactive"); await f.advance(); assert.deepEqual(f.writes, ["idle"]); assert.deepEqual(f.engine.pausedRules, ["idle"]);
});
test("no redundant or flapping writes", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance(); for (let i = 0; i < 20; i++) { f.signal("inactive"); await f.advance(); } assert.deepEqual(f.writes, ["idle"]);
});
test("history retention caps both age and count", () => {
    const f = fixture(); f.engine.sample(); const base = f.history[0]; const now = RETENTION_MS * 2;
    const entries = Array.from({ length: 600 }, (_, i) => ({ ...base, at: now - i })); assert.equal(retain(entries, now).length, 500); assert.deepEqual(retain([{ ...base, at: 0 }, { ...base, at: now + 1 }], now), []);
});
test("provenance follows exact objects, never equal values", () => {
    const p = new Provenance(), callback = () => {}, proto = { status: "idle" }; const token: WriteToken = { generation: 1, target: "idle", rule: "idle" }; p.register(callback, token); p.generated(callback, proto);
    assert.equal(p.take({ status: "idle" }), undefined); assert.equal(p.take(proto), token); assert.equal(p.take(proto), undefined); p.generated(callback, proto); p.clear(); assert.equal(p.take(proto), undefined);
});

test("unavailable webcam detection leaves independent Idle acquisition operational", async () => {
    const f = fixture(); f.signal("inactive", "unknown"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
    f.signal("active", "unknown"); await f.advance(); assert.deepEqual(f.writes, ["idle"]);
});
test("a rejected write pauses without retrying or retaining ownership", async () => {
    const f = fixture(); f.delayWrite(async () => { throw Error("synthetic adapter failure"); });
    f.signal("inactive"); await f.advance(); assert.deepEqual(f.engine.pausedRules, ["idle"]);
    f.signal("inactive"); await f.advance(); assert.deepEqual(f.writes, []); assert.equal(f.engine.ownership, null);
});
test("shutdown cancels pending work before issuing it", async () => {
    const f = fixture(); f.signal("inactive"); f.engine.stop(); await f.advance(); assert.deepEqual(f.writes, []);
});
test("new start epoch rejects fresh-looking detector values retained by an adapter", async () => {
    const f = fixture(); f.s.display.value = "inactive"; f.s.camera.value = "active";
    f.engine.boundary("plugin_start_new_detector_epoch"); f.engine.sample(); await f.advance(); assert.deepEqual(f.writes, []);
    f.signal("active", "inactive"); await f.advance(); assert.deepEqual(f.writes, []);
});

test("history loading preserves distinct same-millisecond observations", () => {
    const f = fixture(); f.engine.sample(); const event = f.history.find(e => e.kind === "observation")!;
    const changed: HistoryEvent = { ...event, status: "idle", configured: "online" };
    assert.deepEqual(mergeHistory([event, changed], [event, changed], event.at), [event, changed]);
});

test("external intervention pauses both owner and in-flight transition rules", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance();
    let release!: () => void; f.delayWrite(() => new Promise(r => { release = r; }));
    f.signal("inactive", "active"); await f.advance(); f.engine.external("external");
    f.s.configured = f.s.effective = "online"; release(); await f.flush(); await f.advance();
    assert.deepEqual(f.engine.pausedRules.sort(), ["camera", "idle"]); assert.deepEqual(f.writes, ["idle"]);
});

test("disabling an awaiting camera transition preserves an enabled Idle owner", async () => {
    const f = fixture(); f.signal("inactive"); await f.advance();
    let release!: () => void; f.delayWrite(() => new Promise(r => { release = r; }));
    f.signal("inactive", "active"); await f.advance(); f.engine.configure({ observe: true, idle: true, camera: false });
    assert.equal(f.engine.ownership?.status, "idle"); release(); await f.flush();
    f.delayWrite(async () => {}); f.signal("active", "inactive"); await f.advance(); assert.deepEqual(f.writes, ["idle", "online"]);
});
test("history clear keeps events recorded after the serialized clear request", async () => {
    const f = fixture(); f.engine.sample(); const original = f.history[0];
    let view = [original]; let release!: () => void;
    const clearing = clearHistoryView({ get: () => view, set: value => { view = value; } }, () => new Promise(r => { release = () => r(undefined); }));
    const later = { ...original, at: original.at + 1 }; view = [...view, later]; release(); await clearing;
    assert.deepEqual(view, [later]);
});

test("failed clear reloads retained startup history and preserves events received during the request", async () => {
    const f = fixture(); f.engine.sample(); const old = f.history[0], recent = { ...old, at: old.at + 1 };
    let events = [recent], generation = 0, release!: (history: HistoryEvent[]) => void;
    const view = { get: () => events, set: (value: HistoryEvent[]) => { events = value; } };
    const startup = loadHistoryView(view, () => new Promise(r => { release = r; }), () => generation === 0, () => recent.at);
    generation++;
    await assert.rejects(clearHistoryView(view, async () => { release([old]); await startup; throw Error("read_only_storage"); }, () => loadHistoryView(view, async () => [old], () => generation === 1, () => recent.at)), /read_only_storage/);
    assert.deepEqual(events, [old, recent]);
});

for (const choice of ["idle", "dnd", "invisible", "unknown"] as const) test(`pending manual ${choice} blocks acquisition from the old Online preference`, async () => {
    const f = fixture(); f.engine.manual(choice);
    f.signal("inactive", "active"); await f.advance(); f.signal("inactive", "active"); await f.advance();
    assert.deepEqual(f.writes, []); assert.equal(f.engine.ownership, null);
    assert.equal(f.engine.latestDecision, "manual_selection_awaiting_configured_status");
    if (choice !== "unknown") { f.s.configured = f.s.effective = choice; f.engine.sample("manual"); await f.advance(); assert.deepEqual(f.writes, []); }
    f.manual("online"); f.signal("active", "active"); await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});

for (const rule of ["idle", "camera"] as const) test(`unattributed intervention during ${rule} debounce pauses that rule`, async () => {
    const f = fixture({ idle: rule === "idle", camera: rule === "camera" });
    f.signal(rule === "idle" ? "inactive" : "active", rule === "camera" ? "active" : "inactive");
    f.engine.external("external"); f.engine.sample(); await f.advance();
    assert.deepEqual(f.writes, []); assert.deepEqual(f.engine.pausedRules, [rule]);
    f.engine.resume(); await f.advance(); assert.deepEqual(f.writes, [rule === "idle" ? "idle" : "dnd"]);
});

test("an unresolved manual choice stays protected across same-account reconnects", async () => {
    const f = fixture(); f.engine.sample(); f.engine.manual("dnd");
    f.s.connected = false; f.engine.boundary("connection_closed"); f.engine.sample(); await f.advance();
    f.s.connected = true; f.engine.boundary("connection_open_new_epoch"); await f.advance();
    f.signal("inactive", "active"); await f.advance(); assert.deepEqual(f.writes, []);
    f.s.account = "different-synthetic-account"; f.engine.sample(); await f.advance();
    f.signal("active", "active"); await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});

test("an unknown account during reconnect cannot revoke unresolved manual intent", async () => {
    const f = fixture(); f.engine.sample(); f.engine.manual("dnd");
    f.s.connected = false; f.s.account = null; f.engine.boundary("connection_closed"); f.engine.sample(); await f.advance();
    f.s.connected = true; f.s.account = "synthetic"; f.engine.boundary("connection_open_new_epoch"); await f.advance();
    f.signal("active", "active"); await f.advance(); assert.deepEqual(f.writes, []);
    f.engine.boundary("logout"); f.s.account = null; f.engine.sample(); await f.advance();
    f.s.account = "synthetic"; f.signal("active", "active"); await f.advance(); assert.deepEqual(f.writes, ["dnd"]);
});
