// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { constants, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { atomicLocalFile, boundedLocalJson } from "../src/core/localFile";

test("bounded JSON reads reject FIFOs without blocking the native queue", t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-file-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const fifo = join(root, "fifo"); execFileSync("mkfifo", [fifo]);
    const module = pathToFileURL(resolve("src/core/localFile.ts")).href;
    const script = `import { boundedLocalJson } from ${JSON.stringify(module)}; try { await boundedLocalJson(process.argv[1]); process.exitCode=1; } catch(e) { if(e.message!=="not_regular_file") throw e; }`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, fifo], { timeout: 3000, stdio: "pipe" });
});
test("bounded JSON reads enforce regular files, valid JSON and size limits", async t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-file-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "sample.json"); writeFileSync(path, "{\"ok\":true}");
    assert.deepEqual(await boundedLocalJson(path), { ok: true }); await assert.rejects(boundedLocalJson(path, 2), /file_too_large/);
    writeFileSync(path, "{"); await assert.rejects(boundedLocalJson(path), SyntaxError);
    const link = join(root, "link"); symlinkSync(path, link); await assert.rejects(boundedLocalJson(link));
    const directory = join(root, "directory"); mkdirSync(directory); await assert.rejects(boundedLocalJson(directory), /not_regular_file/);
});

for (const phase of ["write", "sync", "close", "rename", "success"] as const) test(`atomic history ${phase} leaves no unretained temporary copy`, async () => {
    let temporary = false, destination = "original", contents = "", closed = 0;
    const fail = (step: string) => { if (phase === step) throw Error(`failed_${step}`); };
    const io = {
        lstat: async () => ({ isFile: () => true }),
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
        lstat: async () => ({ isFile: () => true }),
        open: async () => { throw Error("existing_file"); }, rename: async () => {}, unlink: async () => { unlinked = true; }
    }), /existing_file/);
    assert.equal(unlinked, false);
});
test("local writes preserve unexpected non-regular targets", async t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-file-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "fifo"); execFileSync("mkfifo", [path]);
    await assert.rejects(atomicLocalFile(path, []), /unsafe_local_file_target/);
    await assert.rejects(boundedLocalJson(path), /not_regular_file/);
});
