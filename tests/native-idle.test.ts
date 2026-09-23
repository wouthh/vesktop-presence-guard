// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNativeAutomaticIdle } from "../src/core/native-idle";

test("native Idle attribution requires configured Online, native eligibility and the local Idle flag", () => {
    assert.equal(isNativeAutomaticIdle("online", true, true), true);
    assert.equal(isNativeAutomaticIdle("online", false, true), false);
    assert.equal(isNativeAutomaticIdle("online", true, false), false);
    assert.equal(isNativeAutomaticIdle("idle", true, true), false);
    assert.equal(isNativeAutomaticIdle("dnd", true, true), false);
    assert.equal(isNativeAutomaticIdle("invisible", true, true), false);
});
