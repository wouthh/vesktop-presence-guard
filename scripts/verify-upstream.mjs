// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function verifyUpstream(root, expected) {
    const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    if (git(["rev-parse", "HEAD"]) !== expected) throw Error("integration_upstream_revision_mismatch");
    if (git(["status", "--porcelain", "--untracked-files=all"])) throw Error("integration_checkout_dirty_preserved");
    const plugins = join(root, "src/userplugins");
    if (existsSync(plugins) && readdirSync(plugins).some(name => name !== "presenceGuard")) throw Error("integration_unrelated_userplugin_preserved");
    const ignoredSource = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", "src"]);
    if (ignoredSource.split("\n").some(path => path && !path.startsWith("src/userplugins/presenceGuard/"))) throw Error("integration_unexpected_ignored_source");
}
