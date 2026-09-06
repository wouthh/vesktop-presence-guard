// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const entries = git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
const others = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const forbidden = [/\/home\/[a-z][\w.-]*\//i, /(?:mfa\.[\w-]{30,}|gh[pousr]_[\w]{25,})/, /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/, /\b\d{17,20}\b/];
function scan(file, text) {
    if (/^(?:\.cache|dist|node_modules)\//i.test(file)) throw Error(`generated or dependency artifact cannot be published: ${file}`);
    if (/history\.json|installation\.json|diagnostics\.json|discord-web\.js|\.asar$/i.test(file)) throw Error(`private artifact tracked: ${file}`);
    if (forbidden.some(re => re.test(text))) throw Error(`privacy pattern in ${file}; inspect locally before publishing`);
}
function working(file, tracked = false) {
    scan(file, "");
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (tracked && error.code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error(`non-regular source cannot be published: ${file}`);
    scan(file, readFileSync(file, "utf8"));
}
for (const entry of entries) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== "0") throw Error("unmerged_or_invalid_index");
    const [, mode, oid, , file] = match;
    if (!["100644", "100755"].includes(mode)) throw Error(`non-regular source cannot be published: ${file}`);
    scan(file, "");
    scan(file, git(["cat-file", "blob", oid]));
    working(file, true);
}
for (const file of others) working(file);
console.log(`Privacy scan passed for ${entries.length} staged blobs and ${others.length} untracked files, including working copies (manual diff review still required).`);
