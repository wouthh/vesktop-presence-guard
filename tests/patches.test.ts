// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionPatch, protoPatch, selectionPatch } from "../src/patches";
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
