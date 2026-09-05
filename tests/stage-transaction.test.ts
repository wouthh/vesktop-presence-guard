// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error The production JavaScript entry points are linted and tested directly.
import { stage, verifyStaged, inventory } from "../scripts/staging.mjs";

function fixture(t: any) {
    const root = fs.mkdtempSync(join(tmpdir(), "presence-guard-transaction-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project"), vc = join(root, "vencord");
    fs.mkdirSync(join(project, "src"), { recursive: true }); fs.mkdirSync(vc);
    fs.writeFileSync(join(project, "src/buildInfo.ts"), "export const BUILD_INFO = {};\n");
    for (const path of [project, vc]) execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", project, "add", "."]); execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const initial = stage(project, vc), before = inventory(initial.destination);
    fs.writeFileSync(join(project, "src/next.ts"), "// synthetic next version\n");
    return { root, project, vc, initial, before, receipt: join(vc, ".git/presence-guard-stage.json") };
}
for (const operation of ["cpSync", "writeFileSync", "fsyncSync", "renameSync"]) test(`staging retries after every injected ${operation} failure without losing the previous generation`, t => {
    // Discover and fault every actual invocation, including durability and receipt commits.
    let count = 0;
    const probe = fixture(t), counting = { ...fs, [operation]: (...args: any[]) => { count++; return (fs as any)[operation](...args); } };
    stage(probe.project, probe.vc, false, counting);
    for (let fail = 1; fail <= count; fail++) {
        const f = fixture(t); let calls = 0;
        const io = { ...fs, [operation]: (...args: any[]) => { if (++calls === fail) throw Error(`injected_${operation}`); return (fs as any)[operation](...args); } };
        assert.throws(() => stage(f.project, f.vc, false, io), /injected/);
        const generationPaths = [f.initial.destination, ...fs.readdirSync(join(f.vc, ".git")).filter(name => /^\.presence-guard-(next|previous)-/.test(name)).map(name => join(f.vc, ".git", name))];
        const preserved = generationPaths.some(path => { try { return JSON.stringify(inventory(path)) === JSON.stringify(f.before); } catch { return false; } });
        // After the receipt commit, a completely verified next pair is also safe.
        let committed = false;
        try { verifyStaged(f.project, f.initial.destination, f.initial.commit); committed = true; } catch { /* Recovery must retain the old generation. */ }
        assert(preserved || committed, `${operation} failure ${fail} lost both generations`);
        const retry = stage(f.project, f.vc); verifyStaged(f.project, retry.destination, retry.commit);
        assert.deepEqual(stage(f.project, f.vc), retry);
        assert.equal(fs.existsSync(f.receipt + ".transaction"), false);
    }
});
test("recovery refuses altered generations and dry runs never mutate a pending transaction", t => {
    const f = fixture(t); let rename = 0;
    const io = { ...fs, renameSync: (...args: any[]) => { if (++rename === 3) throw Error("interrupted_rename"); return (fs.renameSync as any)(...args); } };
    assert.throws(() => stage(f.project, f.vc, false, io), /interrupted/);
    const tx = fs.readFileSync(f.receipt + ".transaction", "utf8"), data = JSON.parse(tx);
    assert.throws(() => stage(f.project, f.vc, true), /recovery_required/);
    const prior = join(f.vc, ".git", `.presence-guard-previous-${data.id}`);
    fs.writeFileSync(join(prior, "unexpected.txt"), "preserve unexplained data");
    assert.throws(() => stage(f.project, f.vc), /previous_drift/);
    assert.equal(fs.readFileSync(f.receipt + ".transaction", "utf8"), tx);
    assert.equal(fs.readFileSync(join(prior, "unexpected.txt"), "utf8"), "preserve unexplained data");
});
test("same-version staging can recover an interruption between directory renames", t => {
    const f = fixture(t); fs.unlinkSync(join(f.project, "src/next.ts")); let rename = 0;
    const io = { ...fs, renameSync: (...args: any[]) => { if (++rename === 3) throw Error("interrupted_rename"); return (fs.renameSync as any)(...args); } };
    assert.throws(() => stage(f.project, f.vc, false, io), /interrupted/);
    assert.deepEqual(stage(f.project, f.vc), f.initial);
});

test("edits to the old generation during preparation remain untouched", t => {
    const f = fixture(t), receipt = fs.readFileSync(f.receipt, "utf8");
    const io = { ...fs, cpSync: (...args: any[]) => { (fs.cpSync as any)(...args); fs.writeFileSync(join(f.initial.destination, "user-edit.txt"), "unexplained edit"); } };
    assert.throws(() => stage(f.project, f.vc, false, io), /changed_during_preparation/);
    assert.equal(fs.readFileSync(join(f.initial.destination, "user-edit.txt"), "utf8"), "unexplained edit");
    assert.equal(fs.readFileSync(f.receipt, "utf8"), receipt);
});
test("a killed staging-journal writer leaves the original usable and retryable", t => {
    const f = fixture(t), module = pathToFileURL(resolve("scripts/staging.mjs")).href;
    const code = `import * as fs from 'node:fs'; import {stage} from ${JSON.stringify(module)};
      const f=JSON.parse(process.argv[1]); stage(f.project,f.vc,false,{...fs,writeFileSync:(fd,...args)=>{
        if(typeof fd==='number' && fs.readlinkSync('/proc/self/fd/'+fd).includes('.transaction.')){fs.writeSync(fd,'{');process.kill(process.pid,'SIGKILL');}
        return fs.writeFileSync(fd,...args);
      }});`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(f)], { timeout: 5000, stdio: "pipe" }), (error: any) => error.signal === "SIGKILL");
    assert.equal(fs.existsSync(f.receipt + ".transaction"), false);
    assert.deepEqual(inventory(f.initial.destination), f.before);
    assert.deepEqual(fs.readdirSync(join(f.vc, "src/userplugins")), ["presenceGuard"]);
    const retry = stage(f.project, f.vc); verifyStaged(f.project, retry.destination, retry.commit);
});
