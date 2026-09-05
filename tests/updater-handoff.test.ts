// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error JavaScript production tooling is linted and tested directly.
import { hash } from "../scripts/staging.mjs";
// @ts-expect-error JavaScript production tooling is linted and tested directly.
import { runUpdater } from "../scripts/install.mjs";

for (const action of ["rebuild", "activate"]) test(`${action} binds execution to verified bytes while preserving the inherited lock`, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-handoff-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const c = { vencordRoot: root, ledger: join(root, "ledger"), mainLauncher: join(root, "launcher"), updater: join(root, "updater"), updaterLock: join(root, "lock") };
    mkdirSync(join(c.ledger, "backups"), { recursive: true });
    const script = '#!/usr/bin/python3\nimport os,pathlib,re\nassert os.environ["PRESENCE_GUARD_LOCK_FD"]=="4"\nassert re.search(r"FLOCK\\s+ADVISORY\\s+WRITE",pathlib.Path("/proc/self/fdinfo/4").read_text())\nprint("verified-original-executed")\n';
    writeFileSync(c.mainLauncher, "fixture launcher", { mode: 0o700 }); writeFileSync(c.updater, script, { mode: 0o700 });
    writeFileSync(c.updaterLock, "", { mode: 0o600 });
    for (const [path, name] of [[c.mainLauncher, "main-launcher"], [c.updater, "updater"]]) writeFileSync(join(c.ledger, "backups", name), readFileSync(path));
    writeFileSync(join(c.ledger, "backups/main-plugins"), JSON.stringify({ plugins: {} }));
    writeFileSync(join(c.ledger, "backups/executable-modes.json"), JSON.stringify({ "main-launcher": 0o700, updater: 0o700 }));
    writeFileSync(join(c.ledger, "installed-updater.sha256"), hash(script));
    assert.throws(() => runUpdater(c, action), /lock_not_held/);
    const module = pathToFileURL(resolve("scripts/install.mjs")).href;
    const runner = `import {runUpdater} from ${JSON.stringify(module)}; import {execFileSync,spawnSync} from 'node:child_process'; import {renameSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict'; const c=JSON.parse(process.argv[1]); runUpdater(c,process.argv[2],(file,args,options)=>{ assert.equal(spawnSync('/usr/bin/flock',['-n',c.updaterLock,'/usr/bin/true']).status,1); renameSync(c.updater,c.updater+'.prior'); writeFileSync(c.updater,'#!/bin/sh\\necho UNVERIFIED_EXECUTION\\n',{mode:0o700}); return execFileSync(file,args,options); });`;
    const output = execFileSync("/usr/bin/flock", ["--no-fork", "-n", c.updaterLock, process.execPath, "--input-type=module", "-e", runner, JSON.stringify(c), action], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
    assert.match(output, /verified-original-executed/); assert.doesNotMatch(output, /UNVERIFIED_EXECUTION/);
});
