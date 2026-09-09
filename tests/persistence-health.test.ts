// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceHealth } from "../src/core/persistenceHealth";

test("diagnostic persistence failure is reported without rejecting the detector poll", async () => {
    const health = new PersistenceHealth();
    await health.diagnostics(async () => { throw Error("unwritable_diagnostics"); });
    assert.equal(health.summary, "diagnostics_failed");
    await health.diagnostics(async () => {}); assert.equal(health.summary, "healthy");
});
test("unrelated successful operations do not erase a history persistence failure", async () => {
    const health = new PersistenceHealth();
    await assert.rejects(health.run("history_write", async () => { throw Error("disk_full"); }));
    await health.run("history_read", async () => []); await health.diagnostics(async () => {});
    assert.equal(health.summary, "history_write_failed");
    await health.run("history_write", async () => {}); assert.equal(health.summary, "healthy");
    await assert.rejects(health.run("history_read", async () => { throw Error("unreadable_history"); }));
    await health.run("history_write", async () => {}); assert.equal(health.summary, "history_read_failed");
});
