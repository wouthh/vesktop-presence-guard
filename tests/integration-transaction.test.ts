// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error Production JavaScript tooling is linted and tested directly.
import { finishIntegration, pendingIntegration, prepareIntegration, integrationPaths } from "../scripts/integration-transaction.mjs";

function fixture(t: any, kind = "install") {
    const root = fs.mkdtempSync(join(tmpdir(), "presence-guard-integration-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, ledger: join(root, "ledger"), mainProfile: join(root, "profile"), mainLauncher: join(root, "bin/launcher"), updater: join(root, "bin/updater") };
    fs.mkdirSync(c.ledger); fs.writeFileSync(join(c.ledger, "installed-updater.sha256"), "synthetic receipt", { mode: 0o600 }); fs.mkdirSync(dirname(c.mainLauncher)); fs.mkdirSync(join(c.mainProfile, "settings"), { recursive: true });
    const before = join(root, ".wout-releases/before/dist"), after = join(root, ".wout-releases/after/dist");
    for (const path of [before, after]) { fs.mkdirSync(path, { recursive: true }); fs.writeFileSync(join(path, "bundle.js"), path === before ? "before" : "after"); }
    fs.symlinkSync(before, join(root, "dist"));
    fs.writeFileSync(c.mainLauncher, "original launcher", { mode: 0o700 }); fs.writeFileSync(c.updater, "original updater", { mode: 0o700 });
    fs.writeFileSync(join(c.mainProfile, "settings/settings.json"), '{"unchanged":true}', { mode: 0o600 });
    const changes = [{ key: "launcher", data: "prepared launcher", mode: 0o700 }, { key: "settings", data: '{"unchanged":true,"PresenceGuard":true}' }, { key: kind === "install" ? "helperConfig" : "lease", data: "prepared config" }, { key: kind === "install" ? "installed" : "rolledBack", data: "prepared receipt" }];
    const activate = (expected: string) => { assert.equal(expected, after); const link = join(root, "activation.tmp"); fs.symlinkSync(after, link); fs.renameSync(link, join(root, "dist")); };
    const prepare = (io = fs) => prepareIntegration(c, kind, "a".repeat(40), after, changes, io);
    return { c, before, after, changes, activate, prepare };
}
for (const kind of ["install", "rollback"]) for (const operation of ["linkSync", "renameSync", "fsyncSync"]) test(`${kind} recovers after each ${operation} failure following activation`, t => {
    const probe = fixture(t, kind), tx = probe.prepare(); let total = 0;
    finishIntegration(probe.c, tx, probe.activate, false, { ...fs, [operation]: (...args: any[]) => { total++; return (fs as any)[operation](...args); } });
    for (let fail = 1; fail <= total; fail++) {
        const f = fixture(t, kind), tx = f.prepare(); let calls = 0;
        assert.throws(() => finishIntegration(f.c, tx, f.activate, false, { ...fs, [operation]: (...args: any[]) => { if (++calls === fail) throw Error("injected_failure"); return (fs as any)[operation](...args); } }), /injected_failure/);
        const pending = pendingIntegration(f.c);
        if (pending) finishIntegration(f.c, pending, f.activate);
        assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.after);
        for (const change of f.changes) assert.equal(fs.readFileSync(integrationPaths(f.c)[change.key], "utf8"), change.data);
        assert.equal(pendingIntegration(f.c), null);
    }
});
test("preparation failures leave live integration unchanged and permit retry", t => {
    for (const operation of ["writeFileSync", "fsyncSync"]) {
        const probe = fixture(t); let total = 0;
        probe.prepare({ ...fs, [operation]: (...args: any[]) => { total++; return (fs as any)[operation](...args); } } as any);
        for (let fail = 1; fail <= total; fail++) {
            const f = fixture(t); let calls = 0;
            assert.throws(() => f.prepare({ ...fs, [operation]: (...args: any[]) => { if (++calls === fail) throw Error("injected_prepare"); return (fs as any)[operation](...args); } } as any), /injected_prepare/);
            assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before);
            assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher");
            const tx = pendingIntegration(f.c) ?? f.prepare(); finishIntegration(f.c, tx, f.activate);
            assert.equal(pendingIntegration(f.c), null);
        }
    }
});
test("activation can fail after switching the release and still recover", t => {
    const f = fixture(t), tx = f.prepare();
    assert.throws(() => finishIntegration(f.c, tx, (path: string) => { f.activate(path); throw Error("activation_ack_lost"); }), /activation_ack_lost/);
    finishIntegration(f.c, pendingIntegration(f.c), () => { throw Error("must_not_reactivate"); });
    assert.equal(pendingIntegration(f.c), null);
});
test("rollback can cancel an installation that never activated", t => {
    const f = fixture(t), tx = f.prepare();
    assert.throws(() => finishIntegration(f.c, tx, () => { throw Error("activation_failed"); }), /activation_failed/);
    const result = finishIntegration(f.c, pendingIntegration(f.c), () => { throw Error("must_not_activate"); }, true);
    assert.equal(result.cancelled, true); assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before);
    assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher"); assert.equal(pendingIntegration(f.c), null);
});
test("recovery preserves unrelated edits instead of overwriting them", t => {
    const f = fixture(t), tx = f.prepare(); f.activate(f.after); fs.writeFileSync(f.c.mainLauncher, "unexplained edit");
    assert.throws(() => finishIntegration(f.c, tx, f.activate), /target_drift/);
    assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "unexplained edit"); assert(pendingIntegration(f.c));
});

test("prepared-image symlinks are rejected before activating or writing targets", t => {
    const f = fixture(t), tx = f.prepare(), image = join(dirname(f.c.mainLauncher), `.launcher.presence-guard-${tx.id}.image`), copy = image + ".copy";
    fs.writeFileSync(copy, fs.readFileSync(image), { mode: 0o700 }); fs.unlinkSync(image); fs.symlinkSync(copy, image);
    assert.throws(() => finishIntegration(f.c, tx, () => { throw Error("must_not_activate"); }), /ELOOP/);
    assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before); assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher");
});
test("a release manually reverted after partial file writes is not activated again", t => {
    const f = fixture(t), tx = f.prepare(); let renames = 0;
    assert.throws(() => finishIntegration(f.c, tx, f.activate, false, { ...fs, renameSync: (...args: any[]) => { if (++renames === 2) throw Error("interrupted"); return (fs.renameSync as any)(...args); } }), /interrupted/);
    const link = join(f.c.vencordRoot, "external-revert"); fs.symlinkSync(f.before, link); fs.renameSync(link, join(f.c.vencordRoot, "dist"));
    assert.throws(() => finishIntegration(f.c, pendingIntegration(f.c), () => { throw Error("must_not_activate"); }), /release_reverted_after_file_changes/);
    assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before);
});

test("a process killed during journal writing leaves no partial published journal and can retry", t => {
    const f = fixture(t), module = pathToFileURL(resolve("scripts/integration-transaction.mjs")).href;
    const code = `import * as fs from 'node:fs'; import {prepareIntegration} from ${JSON.stringify(module)};
      const f=JSON.parse(process.argv[1]);
      prepareIntegration(f.c,'install','a'.repeat(40),f.after,f.changes,{...fs,writeFileSync:(fd,...args)=>{
        if(fs.readlinkSync('/proc/self/fd/'+fd).includes('.integration-transaction-')){fs.writeSync(fd,'{');process.kill(process.pid,'SIGKILL');}
        return fs.writeFileSync(fd,...args);
      }});`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(f)], { timeout: 5000, stdio: "pipe" }), (error: any) => error.signal === "SIGKILL");
    assert.equal(pendingIntegration(f.c), null);
    assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before);
    assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher");
    finishIntegration(f.c, f.prepare(), f.activate); assert.equal(pendingIntegration(f.c), null);
});
test("recovery rejects a changed installation descriptor before remapping targets", t => {
    const f = fixture(t), tx = f.prepare();
    for (const key of ["mainProfile", "mainLauncher", "updater", "altProfile", "updaterLock", "updaterPending"]) {
        const changed = { ...f.c, [key]: join(f.c.vencordRoot, "replacement") };
        assert.throws(() => pendingIntegration(changed), /descriptor_drift/);
        assert.throws(() => finishIntegration(changed, tx, f.activate), /descriptor_drift/);
    }
    assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher");
});
for (const target of ["updater", "updaterReceipt"]) test(`already-activated recovery rejects ${target} drift before changing files`, t => {
    const f = fixture(t); f.prepare(); f.activate(f.after);
    const path = integrationPaths(f.c)[target]; fs.writeFileSync(path, "unexplained change");
    assert.throws(() => finishIntegration(f.c, pendingIntegration(f.c), () => { throw Error("must_not_activate"); }), /wiring_drift/);
    assert.equal(fs.readFileSync(f.c.mainLauncher, "utf8"), "original launcher");
    assert.equal(fs.readFileSync(path, "utf8"), "unexplained change");
});
test("transaction state refuses newly added special permission bits", t => {
    const f = fixture(t), tx = f.prepare(); fs.chmodSync(f.c.mainLauncher, 0o1700);
    assert.throws(() => finishIntegration(f.c, tx, f.activate), /special_permission_bits/);
    assert.equal(fs.statSync(f.c.mainLauncher).mode & 0o7777, 0o1700);
    assert.equal(fs.realpathSync(join(f.c.vencordRoot, "dist")), f.before);
});
