// SPDX-License-Identifier: GPL-3.0-or-later
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
export function compileHelper(project, commit) {
    let snapshot;
    const authenticated = new Set();
    try {
        if (commit !== undefined) {
            if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("invalid_helper_commit");
            snapshot = mkdtempSync(join(tmpdir(), "presence-guard-helper-"));
            const entries = execFileSync("git", ["-C", project, "ls-tree", "-rz", commit, "--", "helper"], { encoding: "utf8", maxBuffer: 65536 }).split("\0").filter(Boolean);
            if (!entries.length || entries.length > 32) throw Error("invalid_helper_tree");
            for (const entry of entries) {
                const match = /^100644 blob ([a-f0-9]{40})\t(helper\/[a-zA-Z0-9_-]+(?:\.d)?\.ts)$/.exec(entry);
                if (!match) throw Error("unsafe_helper_tree_entry");
                authenticated.add(match[2]);
                const path = join(snapshot, match[2]); mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, execFileSync("git", ["-C", project, "cat-file", "blob", match[1]], { maxBuffer: 1024 * 1024 }), { mode: 0o600, flag: "wx" });
            }
        }
        const build = buildSync({ metafile: true, absWorkingDir: snapshot ?? project, entryPoints: [join(snapshot ?? project, "helper/display-helper.ts")], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", external: ["gi://Gio", "gi://GioUnix", "gi://GLib", "gi://GLibUnix"] });
        if (snapshot && Object.keys(build.metafile.inputs).some(path => !authenticated.has(path))) throw Error("unauthenticated_helper_dependency");
        return Buffer.from(build.outputFiles[0].contents);
    } finally { if (snapshot) rmSync(snapshot, { recursive: true }); }
}
