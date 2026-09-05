// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { loginSession } from "../helper/login-session";
const session = { User: [777, "/synthetic/user"], Active: true, Type: "wayland", Class: "user", LockedHint: false, Id: "synthetic-session" };
test("login1 provides actual lock state separately from screen-shield activity", () => {
    assert.deepEqual(loginSession(session, 777), { locked: false, identity: "synthetic-session" });
    assert.equal(loginSession({ ...session, LockedHint: true }, 777).locked, true);
});
test("missing, other-user, inactive and unsupported login sessions fail closed", () => {
    for (const extra of [{ User: [778] }, { User: null }, { Active: false }, { Type: "x11" }, { Class: "greeter" }, { LockedHint: null }, { Id: "" }]) assert.throws(() => loginSession({ ...session, ...extra }, 777), /unavailable/);
    assert.throws(() => loginSession({}, 777), /unavailable/);
});
