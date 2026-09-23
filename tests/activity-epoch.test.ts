// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityForCurrentEpoch } from "../helper/activity-epoch";

test("activity sampled before a provider or session boundary is not published", () => {
    const beforeBoundary = { idleMs: 100, activitySerial: 2, provider: "session-a" };
    assert.equal(activityForCurrentEpoch(beforeBoundary, 7, 8), null);
});

test("activity sampled in the current epoch remains publishable", () => {
    const current = { idleMs: 300_000, activitySerial: 0, provider: "session-a" };
    assert.equal(activityForCurrentEpoch(current, 8, 8), current);
    assert.equal(activityForCurrentEpoch(null, 8, 8), null);
    assert.equal(activityForCurrentEpoch(current, null, 8), null);
});
