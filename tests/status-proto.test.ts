// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredStatusSignature, parseStatusProto } from "../src/core/statusProto";

test("configured status parser supports status-group drafts and duration fields", () => {
    const parsed = parseStatusProto({ status: { value: "idle" }, statusExpiresAtMs: "3000", statusCreatedAtMs: "1000" });
    assert.equal(parsed.shape, "group");
    assert.equal(parsed.configured, "idle");
    assert.equal(parsed.hasDuration, true);
    assert.equal(parsed.expiresAtMs, "3000");
});

test("current root protobuf envelope parses nested status and wrapped timestamps", () => {
    const parsed = parseStatusProto({ status: { status: { value: "online" }, statusExpiresAtMs: { value: "0" }, statusCreatedAtMs: { value: 1200 } } });
    assert.equal(parsed.shape, "root");
    assert.equal(parsed.configured, "online");
    assert.equal(parsed.expiresAtMs, "0");
    assert.equal(parsed.createdAtMs, "1200");
});

test("group envelope reads duration wrappers beside status and rejects conflicts", () => {
    const parsed = parseStatusProto({ status: { value: "idle", statusExpiresAtMs: { value: "3000" }, statusCreatedAtMs: { value: "1000" } } });
    assert.equal(parsed.shape, "group");
    assert.equal(parsed.configured, "idle");
    assert.equal(parsed.expiresAtMs, "3000");
    assert.equal(parsed.createdAtMs, "1000");

    const conflict = parseStatusProto({ status: { value: "idle", statusExpiresAtMs: "3000" }, statusExpiresAtMs: "4000" });
    assert.equal(conflict.shape, "unsupported");
    assert.equal(conflict.hasStatus, false);
});

test("status-only nested updates are supported and unknown status shapes fail closed", () => {
    assert.equal(parseStatusProto({ status: { status: { value: "dnd" } } }).configured, "dnd");
    assert.equal(parseStatusProto({ status: { unexpected: "idle" } }).shape, "unsupported");
});

test("configured status signatures normalize wrappers and include duration edits", () => {
    const initial = configuredStatusSignature({ value: "idle" }, { value: "1000" }, { value: 500 });
    const edited = configuredStatusSignature("idle", "2000", "500");
    assert.equal(initial, JSON.stringify(["idle", "1000", "500"]));
    assert.notEqual(initial, edited);
    assert.equal(configuredStatusSignature("nonsense", "0", "0"), null);
});
