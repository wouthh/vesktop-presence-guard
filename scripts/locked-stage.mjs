// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdsExclusiveLock } from "./locks.mjs";
import { stage } from "./staging.mjs";
export function stageLock(root) {
    const lock = `${resolve(root)}.presence-guard-stage.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    const fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.uid !== process.getuid()) throw Error("unsafe_stage_lock"); } finally { closeSync(fd); }
    return lock;
}
export function lockedStage(project, root, dry = false) {
    return JSON.parse(execFileSync("/usr/bin/flock", ["--no-fork", "-n", stageLock(root), process.execPath, fileURLToPath(import.meta.url), resolve(project), resolve(root), dry ? "dry" : "write"], { encoding: "utf8", maxBuffer: 65536 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [project, root, mode] = process.argv.slice(2);
    if (!project || !root || !["dry", "write"].includes(mode) || !holdsExclusiveLock(stageLock(root))) throw Error("staging_lock_not_held");
    console.log(JSON.stringify(stage(project, root, mode === "dry")));
}
