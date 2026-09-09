// SPDX-License-Identifier: GPL-3.0-or-later
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function assertStagingParents(destination) {
    const plugins = dirname(destination), src = dirname(plugins), root = dirname(src);
    if (basename(destination) !== "presenceGuard" || basename(plugins) !== "userplugins" || basename(src) !== "src") throw Error("invalid_staging_destination");
    for (const path of [root, join(root, "src"), plugins]) {
        let stat;
        try { stat = lstatSync(path); } catch (e) { if (e.code === "ENOENT" && path !== root) return; throw e; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe_staging_parent_preserved");
    }
}
