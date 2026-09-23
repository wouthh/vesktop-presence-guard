// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionPatch, nativeIdlePatch, protoPatch, saveLifecyclePatch, selectionPatch } from "../src/patches";
import { Provenance } from "../src/core/provenance";
// Minimal authored fixtures. No cached Discord bundles or account data.
test("picker patches invoke manual hook for same value and duration, preserving options", async () => {
    const order: string[] = [];
    const self = { manualProviderReady: () => order.push("ready"), manualOptions: (o: any) => { order.push("manual"); return o; }, statusAction: () => order.push("action") };
    const action = 'async function choose(a){let{nextStatus:s,prevStatus:p}=a;return a;}'.replace(actionPatch.replacement.match, actionPatch.replacement.replace);
    let code = 'function picker(o){let{status:s,currentStatus:c,description:d}=o;let m=900;return {click:()=>choose({nextStatus:s,prevStatus:c}),duration:()=>choose({nextStatus:s,prevStatus:c,durationMillis:m}),description:d}}';
    for (const replacement of selectionPatch.replacement) code = code.replace(replacement.match, replacement.replace);
    const picker = new Function("$self", `${action};${code};return picker;`)(self);
    const p = picker({ status: "idle", currentStatus: "idle", description: "synthetic" });
    assert.deepEqual(await p.click(), { nextStatus: "idle", prevStatus: "idle" });
    assert.deepEqual(await p.duration(), { nextStatus: "idle", prevStatus: "idle", durationMillis: 900 });
    assert.deepEqual(order, ["ready", "manual", "action", "manual", "action"]);
});
test("async updater patch carries exact callback/proto identity across load", async () => {
    const provenance = new Provenance();
    const callback = () => {}, token = { generation: 1, target: "idle" as const, rule: "idle" as const }; provenance.register(callback, token);
    const partial = { status: { value: "idle" } };
    let observed: unknown;
    const self = { generatedUpdate: (cb: object, proto: object) => provenance.generated(cb, proto) };
    const code = 'return new class{loadIfNecessary(){return Promise.resolve()}build(){return partial}markDirty(s){observed(s)}async updateAsync(e,t,n,i){await this.loadIfNecessary();let s=this.build(e,t);null!=s&&(__OVERLAY__?null:this.markDirty(s))}}';
    const patched = code.replace(protoPatch.replacement.match, protoPatch.replacement.replace);
    assert.notEqual(patched, code);
    const updater = new Function("$self", "partial", "observed", "__OVERLAY__", patched)(self, partial, (proto: object) => { observed = provenance.take(proto); }, false);
    await updater.updateAsync("status", callback, 1); assert.equal(observed, token);
});

test("save provenance follows the exact updater, queued token, and returned configured status", () => {
    const p = new Provenance(), updater = {}, otherUpdater = {};
    const callback = () => {}, token = { generation: 4, target: "idle" as const, rule: "idle" as const };
    const partial = { status: { value: "idle" }, statusExpiresAtMs: 1000, statusCreatedAtMs: 500 };
    p.register(callback, token); p.generated(callback, partial);
    assert.equal(p.saveQueued(otherUpdater, partial), token);
    assert.equal(p.saveStarted(updater, partial), undefined);
    assert.equal(p.saveQueued(updater, partial), token);
    const sent = { status: { value: "idle" }, statusExpiresAtMs: 1000, statusCreatedAtMs: 500 };
    const context = p.saveStarted(updater, sent)!;
    const unrelated = { status: { value: "idle" }, statusExpiresAtMs: 1000, statusCreatedAtMs: 500 };
    assert.equal(p.takeSaveAck(unrelated), false);
    assert.equal(p.saveSucceeded(updater, context, unrelated), true);
    assert.equal(p.takeSaveAck(unrelated), true);
    assert.equal(p.takeSaveAck(unrelated), false);
});
test("save acknowledgement rejects a changed duration or a nonmatching configured value", () => {
    const p = new Provenance(), updater = {}, callback = () => {};
    const token = { generation: 1, target: "idle" as const, rule: "idle" as const };
    const local = { status: { value: "idle" }, statusExpiresAtMs: 1000, statusCreatedAtMs: 500 };
    p.register(callback, token); p.generated(callback, local); p.saveQueued(updater, local);
    const context = p.saveStarted(updater, local)!;
    assert.equal(p.saveSucceeded(updater, context, { status: { value: "idle" }, statusExpiresAtMs: 2000, statusCreatedAtMs: 500 }), false);
    assert.equal(p.saveSucceeded(updater, context, { status: { value: "online" }, statusExpiresAtMs: 1000, statusCreatedAtMs: 500 }), false);
});
test("rate-limit retry keeps exact save context; terminal failures discard it", () => {
    const p = new Provenance(), updater = {}, callback = () => {};
    const token = { generation: 2, target: "idle" as const, rule: "idle" as const };
    const proto = { status: { value: "idle" } };
    p.register(callback, token); p.generated(callback, proto); p.saveQueued(updater, proto);
    const first = p.saveStarted(updater, proto)!; p.saveFailed(updater, first, true);
    assert(p.saveStarted(updater, proto));
    p.saveFailed(updater, first, false);
    assert.equal(p.saveStarted(updater, proto), undefined);
});
test("revoked manual intervention prevents a late same-value save from being correlated", () => {
    const p = new Provenance(), updater = {}, callback = () => {};
    const token = { generation: 3, target: "idle" as const, rule: "idle" as const };
    const proto = { status: { value: "idle" } };
    p.register(callback, token); p.generated(callback, proto); p.saveQueued(updater, proto);
    const context = p.saveStarted(updater, proto)!;
    p.clear();
    const late = { status: { value: "idle" } };
    assert.equal(p.saveSucceeded(updater, context, late), false);
    assert.equal(p.takeSaveAck(late), false);
    assert.equal(p.saveStarted(updater, late), undefined);
});

test("save lifecycle patch matches updater queue, request, success and failure closures", () => {
    let code = 'new class{markDirty(e,t){this.value=e}persistChanges=async()=>{let{editInfo:e}=this.getEditInfo();if(null==e.protoToSave)return void this.logger.log("empty");this.beforeSendCallbacks.forEach(t=>t.processProto(e.protoToSave));let t=(0,m.ob)(this.ProtoClass,e.protoToSave);if(null==t||""===t)return void this.logger.log("empty");try{let{body:n}=await a.Bo.patch({body:t});let i=(0,m.ii)(this.ProtoClass,n.settings);if(null==i)return;c.h.dispatch({type:"USER_SETTINGS_PROTO_UPDATE",settings:{proto:i,type:this.type},resetEditInfo:!0,wasSaved:!0,local:!1})}catch(e){throw e}}}';
    for (const replacement of saveLifecyclePatch.replacement) {
        const next = code.replace(replacement.match, replacement.replace);
        assert.notEqual(next, code); code = next;
    }
    assert(code.includes('saveFailed(this,presenceGuardSave,e?.status===429?"rate_limited":"terminal")'));
    new Function("$self", "m", "a", "c", `return (${code})();`);
});

test("native Idle integration changes only the local IDLE branch and keeps its reevaluator Idle-only", () => {
    const source = 'function N(){let e;Date.now()-I>A.sdF||S()?f||l.h.dispatch({type:"IDLE",idle:!0,idleSince:I}):f&&l.h.dispatch({type:"IDLE",idle:!1}),0===(e=c.cU.getSetting())||null!=i||Date.now()-I>Math.min(e*u.A.Millis.SECOND,A.sdF)||S()?p||l.h.dispatch({type:"AFK",afk:!0}):p&&l.h.dispatch({type:"AFK",afk:!1})}';
    const code = source.replace(nativeIdlePatch.replacement.match, nativeIdlePatch.replacement.replace);
    assert.notEqual(code, source);
    const events: any[] = []; let reconcile!: () => void, idle = true; const idleSince = 1000;
    let decisionInput: boolean | undefined, suppress = true;
    const nativeObservations: [boolean, boolean][] = [];
    const self = { nativeIdleProviderReady: (fn: () => void) => { reconcile = fn; }, nativeIdleDecision: (eligible: boolean) => { decisionInput = eligible; return suppress ? false : eligible; }, nativeIdleCurrent: () => idle, nativeIdleObserved: (eligible: boolean, localIdle: boolean) => nativeObservations.push([eligible, localIdle]), nativeIdleDispatch: (next: boolean) => { idle = next; } };
    const N = new Function("$self", "Date", "I", "A", "S", "f", "l", "c", "i", "u", "p", `return (${code});`)(self, Date, 1000, { sdF: 1 }, () => false, idle, { h: { dispatch: (event: any) => { events.push(event); if (event.type === "IDLE") idle = event.idle; } } }, { cU: { getSetting: () => 0 } }, null, { A: { Millis: { SECOND: 1000 } } }, false);
    N(); const afkCount = events.filter(event => event.type === "AFK").length; const timestamp = idleSince;
    assert.deepEqual(events.filter(event => event.type === "IDLE").map(event => event.idle), [false]);
    assert.equal(decisionInput, true);
    reconcile(); assert.deepEqual(nativeObservations, [[false, false]]); assert.equal(events.filter(event => event.type === "AFK").length, afkCount);
    suppress = false; reconcile();
    assert.deepEqual(nativeObservations, [[false, false], [true, false]]);
    assert.deepEqual(events.filter(event => event.type === "IDLE").map(event => event.idle), [false, true]);
    assert.equal(idle, true);
    assert.equal(events.filter(event => event.type === "AFK").length, afkCount);
    assert.equal(idleSince, timestamp);
});
