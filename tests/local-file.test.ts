// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { test } from "node:test";
import { atomicLocalFile } from "../src/core/localFile";

for (const phase of ["write", "sync", "close", "rename", "success"] as const) test(`atomic history ${phase} leaves no unretained temporary copy`, async () => {
    let temporary = false, destination = "original", contents = "", closed = 0;
    const fail = (step: string) => { if (phase === step) throw Error(`failed_${step}`); };
    const io = {
        open: async (_path: string, flags: number, mode: number) => {
            assert(flags & constants.O_EXCL); assert(flags & constants.O_NOFOLLOW); assert.equal(mode, 0o600);
            temporary = true;
            return {
                writeFile: async (data: string) => { contents = data; fail("write"); },
                sync: async () => fail("sync"),
                close: async () => { closed++; if (closed === 1) fail("close"); }
            };
        },
        rename: async () => { fail("rename"); destination = contents; temporary = false; },
        unlink: async () => { if (!temporary) throw Object.assign(Error("missing"), { code: "ENOENT" }); temporary = false; }
    };
    const operation = atomicLocalFile("synthetic/history.json", [{ status: "idle" }], io);
    if (phase === "success") await operation; else await assert.rejects(operation, new RegExp(`failed_${phase}`));
    assert.equal(temporary, false); assert(closed > 0);
    assert.equal(destination, phase === "success" ? '[{"status":"idle"}]' : "original");
});

test("failed exclusive open does not delete an unowned temporary file", async () => {
    let unlinked = false;
    await assert.rejects(atomicLocalFile("synthetic/history.json", [], {
        open: async () => { throw Error("existing_file"); }, rename: async () => {}, unlink: async () => { unlinked = true; }
    }), /existing_file/);
    assert.equal(unlinked, false);
});
