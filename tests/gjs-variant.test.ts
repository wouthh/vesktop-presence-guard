// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
test("installed GJS retains the Properties.Get variant wrapper after tuple deepUnpack", { skip: !existsSync("/usr/bin/gjs") }, () => {
    const code = 'const GLib=imports.gi.GLib; const value=new GLib.Variant("(v)",[new GLib.Variant("i",0)]).deepUnpack()[0]; print(JSON.stringify({isVariant:value instanceof GLib.Variant,power:value.deepUnpack()}));';
    const result = execFileSync("/usr/bin/gjs", ["-c", code], { encoding: "utf8", timeout: 3000 });
    assert.deepEqual(JSON.parse(result), { isVariant: true, power: 0 });
});
