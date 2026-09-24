// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { PresenceEngine } from "../src/core/engine";
import { Provenance } from "../src/core/provenance";
import { classifyWriteError, isStatusSettingsEventType, PRELOADED_SETTINGS_PROTO, resolveStatusUpdater, sanitizeLastWrite, STATUS_SETTINGS_PROTO, StatusWriteTrace, supportsStatusSchema, writeConfiguredStatus } from "../src/core/statusUpdater";
import { UNKNOWN, type Clock, type Snapshot, type WriteToken } from "../src/core/types";

function descriptor(name: string, no: number, kind: string, type?: Record<string, unknown>) {
    return { localName: name, no, kind, ...(type ? { T: () => type } : {}) };
}

const stringValue = {
    typeName: "google.protobuf.StringValue",
    fields: [descriptor("value", 1, "scalar")]
};
const statusSettings = {
    typeName: STATUS_SETTINGS_PROTO,
    fields: [descriptor("status", 1, "message", stringValue)]
};
const preloadedSettings = {
    typeName: PRELOADED_SETTINGS_PROTO,
    fields: [descriptor("status", 11, "message", statusSettings)]
};

function updater(type: number, protoClass: typeof preloadedSettings | { typeName: string; fields: unknown[] }) {
    return {
        type,
        ProtoClass: protoClass,
        updateAsync() { return "generatedUpdate("; },
        markDirty() { return "saveQueued("; },
        persistChanges() { return "saveStarted(saveSucceeded(saveUnavailable(saveFailed("; }
    };
}

test("semantic updater resolution skips favourites when it is exported first", () => {
    const favourites = updater(2, { typeName: "discord_protos.discord_users.v1.FrecencyUserSettings", fields: [] });
    const status = updater(1, preloadedSettings);
    const resolution = resolveStatusUpdater([favourites, status]);
    assert.equal(resolution.instance, status);
    assert.equal(resolution.type, 1);
    assert.equal(resolution.readiness, "ready");
});

test("favourites settings events cannot enter configured-status provenance", () => {
    assert.equal(isStatusSettingsEventType(1), true);
    assert.equal(isStatusSettingsEventType(2), false);
    assert.equal(isStatusSettingsEventType(undefined), false);
});

test("write diagnostics retain classified outcomes and discard arbitrary exception text", () => {
    const trace = new StatusWriteTrace();
    const token: WriteToken = { generation: 3, target: "idle", rule: "idle" };
    trace.begin(token, 10_000);
    trace.update(token, "mutation_started", "pending", 10_001);
    trace.update(token, "failed", "failed", 10_002, classifyWriteError(Error("Unknown proto field name status")));
    const safe = sanitizeLastWrite({ ...trace.lastWrite, exception: "private response payload", errorCode: "arbitrary text" });
    assert.deepEqual(safe, { operation: 1, target: "idle", phase: "failed", requestedAt: 10_000, updatedAt: 10_002, outcome: "failed" });
    assert.equal(classifyWriteError(Error("status_shape_unknown")), "status_draft_unsupported");
    assert.equal(classifyWriteError(Error("Unknown proto field name status")), "status_updater_schema_rejected");
});

test("missing local confirmation remains an explicit terminal write outcome", async () => {
    const trace = new StatusWriteTrace();
    const token: WriteToken = { generation: 4, target: "idle", rule: "idle" };
    const instance = { async updateAsync() {} };
    await assert.rejects(writeConfiguredStatus({
        updater: instance,
        currentUpdater: () => instance,
        ready: () => true,
        token,
        guard: () => true,
        delay: 1,
        register: () => {},
        trace,
        now: () => 20_000
    }), /local_confirmation_missing/);
    assert.deepEqual(trace.lastWrite, { operation: 1, target: "idle", phase: "confirmation_missing", requestedAt: 20_000, updatedAt: 20_000, outcome: "unavailable", errorCode: "local_confirmation_missing" });
});

test("status updater schema validates the root status descriptor and wrapped StringValue", () => {
    assert.equal(supportsStatusSchema(preloadedSettings), true);
    assert.equal(supportsStatusSchema({ ...preloadedSettings, fields: [descriptor("status", 10, "message", statusSettings)] }), false);
    assert.equal(supportsStatusSchema({ ...preloadedSettings, fields: [descriptor("status", 11, "message", { ...statusSettings, typeName: "WrongStatusSettings" })] }), false);
    assert.equal(supportsStatusSchema({ ...preloadedSettings, fields: [descriptor("status", 11, "message", { ...statusSettings, fields: [descriptor("status", 1, "scalar")] })] }), false);
});

test("wrong settings metadata, unknown schema and missing hooks fail closed", () => {
    const favourites = updater(2, { typeName: "discord_protos.discord_users.v1.FrecencyUserSettings", fields: [] });
    assert.equal(resolveStatusUpdater([favourites]).readiness, "metadata_mismatch");
    assert.equal(resolveStatusUpdater([]).readiness, "not_found");

    const unknownSchema = updater(1, { typeName: PRELOADED_SETTINGS_PROTO, fields: [] });
    assert.equal(resolveStatusUpdater([unknownSchema]).readiness, "schema_mismatch");

    const unpatched = { ...updater(1, preloadedSettings), updateAsync() {}, markDirty() {}, persistChanges() {} };
    assert.equal(resolveStatusUpdater([unpatched]).readiness, "patches_unavailable");
});

test("ambiguous exact settings instances are not silently selected", () => {
    const first = updater(1, preloadedSettings);
    const second = updater(1, preloadedSettings);
    assert.equal(resolveStatusUpdater([first, second]).instance, null);
    assert.equal(resolveStatusUpdater([first, second]).readiness, "metadata_mismatch");
});

test("production resolver and guarded writer use the raw Preloaded updater when favourites exports first", async () => {
    let now = 100_000;
    let timer: (() => void) | undefined;
    const clock: Clock = { now: () => now, set: callback => { timer = callback; return callback; }, clear: handle => { if (timer === handle) timer = undefined; } };
    const snapshot: Snapshot = {
        account: "synthetic-account", connected: true, capable: true, nativeIdleHookReady: true,
        configured: "online", effective: "idle", aggregate: "idle", nativeIdle: true, nativeIdleAttributed: true,
        activity: { value: "inactive", at: now, reason: "synthetic_idle_counter", scope: "synthetic desktop" },
        display: UNKNOWN("synthetic display"), camera: UNKNOWN("synthetic camera")
    };
    const events: Array<{ kind: string; saveState?: string }> = [];
    const provenance = new Provenance();
    const trace = new StatusWriteTrace();
    const engineRef: { current?: PresenceEngine } = {};
    let favoritesLoads = 0;
    let favoritesMutations = 0;
    const favorites = {
        ...updater(2, { typeName: "discord_protos.discord_users.v1.FrecencyUserSettings", fields: [] }),
        async updateAsync() { favoritesLoads++; favoritesMutations++; }
    };
    let statusLoads = 0;
    let statusMutations = 0;
    let receiverIsSelected = false;
    let saveEvidence = "unavailable";
    const statusUpdater: any = {
        ...updater(1, preloadedSettings),
        generatedUpdate(owner: object, callback: object, proto: object) { provenance.generated(owner, callback, proto); },
        saveQueued(owner: object, proto: object) {
            const token = provenance.saveQueued(owner, proto);
            if (token) { trace.update(token, "save_pending", "save_pending", now); engineRef.current?.saveOutcome(token, "pending", "synthetic_queued"); }
        },
        saveStarted(owner: object, proto: object) { return provenance.saveStarted(owner, proto); },
        saveSucceeded(owner: object, context: any, proto: object) {
            const outcome = provenance.saveSucceeded(owner, context, proto);
            saveEvidence = outcome.state;
            if (outcome.state === "succeeded") for (const token of outcome.tokens) {
                saveEvidence = "correlated_save_confirmed";
                trace.update(token, "save_succeeded", "save_confirmed", now);
                engineRef.current?.saveOutcome(token, "succeeded", "synthetic_correlated_save");
            }
            return outcome;
        },
        async loadIfNecessary() { statusLoads++; }
    };
    statusUpdater.markDirty = function (proto: object) { this.saveQueued(this, proto); return "saveQueued("; };
    statusUpdater.updateAsync = async function (group: string, callback: (draft: any) => void) {
            receiverIsSelected = this === statusUpdater;
            assert.equal(group, "status");
            await this.loadIfNecessary();
            const draft = { status: { value: snapshot.configured } };
            callback(draft);
            statusMutations++;
            const proto = { status: { status: { value: draft.status.value } } };
            this.generatedUpdate(this, callback, proto);
            this.markDirty(proto);
            const token = provenance.take(proto);
            snapshot.configured = draft.status.value;
            if (token) {
                trace.update(token, "locally_applied", "locally_applied", now);
                engineRef.current?.sample("plugin", token);
            }
            const context = this.saveStarted(this, proto);
            const ack = { status: { status: { value: draft.status.value } } };
            this.saveSucceeded(this, context, ack);
        };
    const resolution = resolveStatusUpdater([favorites, statusUpdater]);
    assert.equal(resolution.instance, statusUpdater);
    assert.equal(resolution.readiness, "ready");
    const engine = new PresenceEngine({
        read: () => snapshot,
        write: (token: WriteToken, guard: () => boolean) => writeConfiguredStatus({
            updater: resolution.instance,
            currentUpdater: () => resolution.instance,
            ready: () => resolution.readiness === "ready",
            token, guard, delay: 1,
            register: (callback, current, owner) => provenance.register(callback, current, owner),
            trace, now: () => now
        }),
        record: event => events.push(event)
    }, clock, { observe: true, idle: true, camera: false });
    engineRef.current = engine;

    engine.sample();
    now += 2_000; timer?.(); timer = undefined;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(favoritesLoads, 0);
    assert.equal(favoritesMutations, 0);
    assert.equal(statusLoads, 1);
    assert.equal(statusMutations, 1);
    assert.equal(receiverIsSelected, true);
    assert.equal(snapshot.configured, "idle");
    assert.equal(snapshot.effective, "idle");
    assert.equal(snapshot.nativeIdleAttributed, true);
    assert.equal(engine.ownership?.status, "idle");
    assert.equal(saveEvidence, "correlated_save_confirmed");
    assert.equal(trace.lastWrite?.outcome, "save_confirmed");
    assert(events.some(event => event.kind === "confirmation"));
});
