// SPDX-License-Identifier: GPL-3.0-or-later
import { build } from "esbuild";
await build({ entryPoints: ["helper/display-helper.ts"], outfile: "dist/display-helper.mjs", bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["gi://Gio", "gi://GLib", "gi://GLibUnix"] });
