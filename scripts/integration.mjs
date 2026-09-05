// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stage, UPSTREAM } from "./staging.mjs";
import { verifyUpstream } from "./verify-upstream.mjs";
const root = resolve(process.env.PRESENCE_GUARD_TEST_VENCORD ?? ".cache/Vencord");
function run(cmd, args) { const p = spawnSync(cmd, args, { cwd: root, stdio: "inherit" }); if (p.status !== 0) process.exit(p.status ?? 1); }
if (!existsSync(root)) {
    mkdirSync(resolve(".cache"), { recursive: true });
    execFileSync("git", ["clone", "--no-checkout", "https://github.com/Vendicated/Vencord.git", root], { stdio: "inherit" });
    run("git", ["checkout", "--detach", UPSTREAM]);
}
verifyUpstream(root, UPSTREAM);
stage(process.cwd(), root);
if (!existsSync(resolve(root, "node_modules"))) run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
run("pnpm", ["testTsc"]);
run("pnpm", ["exec", "eslint", "src/userplugins/presenceGuard"]);
run("pnpm", ["buildStandalone"]);
for (const file of ["vencordDesktopRenderer.js", "vencordDesktopMain.js"]) {
    if (!readFileSync(resolve(root, "dist", file), "utf8").includes("PresenceGuard")) throw Error("missing_bundle_plugin_identity");
}
console.log(`Pinned upstream integration passed: ${UPSTREAM}`);
