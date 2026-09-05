// SPDX-License-Identifier: GPL-3.0-or-later
import { buildSync } from "esbuild";
import { join } from "node:path";
export function compileHelper(project) {
    return Buffer.from(buildSync({ entryPoints: [join(project, "helper/display-helper.ts")], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", external: ["gi://Gio", "gi://GLib", "gi://GLibUnix"] }).outputFiles[0].contents);
}
