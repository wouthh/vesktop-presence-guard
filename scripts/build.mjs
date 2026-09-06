// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from "node:fs";
import { compileHelper } from "./helper-build.mjs";
mkdirSync("dist", { recursive: true }); writeFileSync("dist/display-helper.mjs", compileHelper(process.cwd()));
