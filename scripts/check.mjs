// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
function run(cmd, args) { const p = spawnSync(cmd, args, { stdio: "inherit" }); if (p.status !== 0) process.exit(p.status ?? 1); }
for (const lane of ["lint", "typecheck", "test", "build"]) run("pnpm", ["run", lane]);
run(process.execPath, ["scripts/privacy.mjs"]);
run(process.execPath, ["scripts/integration.mjs"]);
