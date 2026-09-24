// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDetectorSnapshot } from "../src/core/detectorSnapshot";

const activity = { at: 1000, idleMs: null, suspended: false, provider: "synthetic-provider", activitySerial: 1, activityAt: 990, inputOnly: true as const };
const observation = { at: 1000, power: 0, idleMs: -1, thresholdMs: 300_000, locked: false, shieldActive: false, suspended: false, topology: "[]", monitors: 1, provider: "synthetic-display" };

test("display and input evidence are accepted from one fresh helper generation", () => {
    const snapshot = validateDetectorSnapshot({ version: 2, sequence: 8, at: 1000, observation, activity }, 1200);
    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.sequence, 8);
    assert.equal(snapshot.observation?.at, snapshot.activity?.at);
    assert.equal(snapshot.activity?.inputOnly, true);
});

test("stale helper generation invalidates both observations without mixing sample times", () => {
    const snapshot = validateDetectorSnapshot({ version: 2, sequence: 8, at: 1000, observation, activity }, 12_000);
    assert.equal(snapshot.reason, "snapshot_stale");
    assert.equal(snapshot.observation, null);
    assert.equal(snapshot.activity, null);
});

test("unknown snapshot and malformed one-shot activity fail closed", () => {
    assert.equal(validateDetectorSnapshot({ version: 1, at: 1000, observation, activity }, 1200).healthy, false);
    const snapshot = validateDetectorSnapshot({ version: 2, sequence: 9, at: 1000, observation, activity: { ...activity, activityAt: 0 } }, 1200);
    assert.equal(snapshot.observation?.at, 1000);
    assert.equal(snapshot.activity, null);
});

test("a fresh helper shutdown receipt is not reported as a healthy lease", () => {
    const snapshot = validateDetectorSnapshot({ version: 2, sequence: 10, at: 1000, observation: null, activity: null, reason: "lease_inactive" }, 1200);
    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.helperLeaseHealthy, false);
});
