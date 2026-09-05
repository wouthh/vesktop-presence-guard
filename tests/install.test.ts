// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error JavaScript installation entry point is checked by ESLint and exercised here.
import { enableMain } from "../scripts/install.mjs";
import { statusMutator } from "../src/core/mutator";
test("first installation enables observation, preserves unrelated settings and remains idempotent", () => {
    const before = { plugins: { ExistingPlugin: { enabled: true, value: 7 } }, theme: "synthetic" };
    const installed = enableMain(before);
    assert.deepEqual(installed.plugins.PresenceGuard, { enabled: true, observe: true, idle: false, camera: false });
    assert.deepEqual(installed.plugins.ExistingPlugin, before.plugins.ExistingPlugin); assert.deepEqual(enableMain(installed), installed); assert.equal((before.plugins as any).PresenceGuard, undefined);
});
test("updates preserve opt-in preferences", () => {
    const s = { plugins: { PresenceGuard: { enabled: true, observe: false, idle: true, camera: false } } }; assert.deepEqual(enableMain(s), s);
});
test("production mutator preserves duration and unrelated profile fields", () => {
    const s = { status: { value: "online", extra: "wrapper" }, statusExpiresAtMs: "900", statusCreatedAtMs: { value: "100" }, customStatus: { text: "synthetic" }, showCurrentGame: false };
    const before = structuredClone(s); statusMutator("idle", () => true)(s); assert.deepEqual(s, { ...before, status: { ...before.status, value: "idle" } });
    assert.throws(() => statusMutator("dnd", () => false)(s)); assert.equal(s.status.value, "idle");
});
