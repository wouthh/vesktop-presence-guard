// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
export const UPSTREAM = "0e40e433d7aa9168f656aba733d01e761b7ca8ca";
export const hash = value => createHash("sha256").update(value).digest("hex");
export function inventory(root) {
    const result = {};
    function visit(directory, prefix = "") {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name), relative = prefix + name;
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) throw Error("symlink_in_staging_source");
            if (stat.isDirectory()) visit(path, `${relative}/`);
            else if (stat.isFile()) result[relative] = hash(readFileSync(path));
            else throw Error("unsupported_staging_file");
        }
    }
    visit(root); return result;
}
function buildInfo(source, commit) {
    const header = readFileSync(join(source, "buildInfo.ts"), "utf8").split("export const")[0];
    return `${header}export const BUILD_INFO = { commit: ${JSON.stringify(commit)}, upstream: ${JSON.stringify(UPSTREAM)} };\n`;
}
export function verifyStaged(project, destination, commit) {
    const source = join(project, "src"), canonical = inventory(source);
    const m = JSON.parse(readFileSync(join(destination, ".presence-guard-stage.json"), "utf8"));
    const expected = { ...canonical, "buildInfo.ts": hash(buildInfo(source, commit)) };
    const actual = inventory(destination); delete actual[".presence-guard-stage.json"];
    if (m.version !== 1 || m.commit !== commit || m.upstream !== UPSTREAM || m.sourceHash !== hash(JSON.stringify(canonical)) || JSON.stringify(m.files) !== JSON.stringify(expected) || JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("staging_not_canonical_reviewed_source");
    return m;
}
export function stage(project, vencord, dryRun = false) {
    const destination = join(resolve(vencord), "src/userplugins/presenceGuard");
    const commit = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const source = join(project, "src"), files = inventory(source);
    const sourceHash = hash(JSON.stringify(files));
    if (existsSync(destination)) {
        if (lstatSync(destination).isSymbolicLink()) throw Error("unexpected_staging_symlink");
        const marker = join(destination, ".presence-guard-stage.json");
        if (!existsSync(marker)) throw Error("unowned_staging_directory");
        const old = JSON.parse(readFileSync(marker, "utf8")), actual = inventory(destination);
        delete actual[".presence-guard-stage.json"];
        if (JSON.stringify(actual) !== JSON.stringify(old.files)) throw Error("staged_source_drift");
    }
    if (dryRun) return { destination, commit, sourceHash, files: Object.keys(files).length };
    if (existsSync(destination)) rmSync(destination, { recursive: true }); // Exact, verified, generated tree only.
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, errorOnExist: true });
    writeFileSync(join(destination, "buildInfo.ts"), buildInfo(source, commit));
    const staged = inventory(destination);
    const manifest = { version: 1, commit, upstream: UPSTREAM, sourceHash, files: staged };
    writeFileSync(join(destination, ".presence-guard-stage.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (hash(JSON.stringify(inventory(source))) !== sourceHash) throw Error("canonical_source_changed_during_staging");
    return { destination, commit, sourceHash, files: Object.keys(files).length };
}
