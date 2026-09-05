// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { accessSync, constants, existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { regularBytes } from "./regular-file.mjs";
import { recoverStage, replaceStage } from "./stage-transaction.mjs";
export const UPSTREAM = "0e40e433d7aa9168f656aba733d01e761b7ca8ca";
export const hash = value => createHash("sha256").update(value).digest("hex");
export function inventory(root) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe_inventory_root");
    const result = {};
    function visit(directory, prefix = "") {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name), relative = prefix + name;
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) throw Error("symlink_in_staging_source");
            if (stat.isDirectory()) visit(path, `${relative}/`);
            else if (stat.isFile()) result[relative] = hash(regularBytes(path, undefined, 64 * 1024 * 1024));
            else throw Error("unsupported_staging_file");
        }
    }
    visit(root); return result;
}
function buildInfo(source, commit) {
    const header = regularBytes(join(source, "buildInfo.ts"), "utf8").split("export const")[0];
    return `${header}export const BUILD_INFO = { commit: ${JSON.stringify(commit)}, upstream: ${JSON.stringify(UPSTREAM)} };\n`;
}
export function verifyStaged(project, destination, commit) {
    const source = join(project, "src"), canonical = inventory(source);
    const m = JSON.parse(regularBytes(join(destination, ".presence-guard-stage.json"), "utf8"));
    const expected = { ...canonical, "buildInfo.ts": hash(buildInfo(source, commit)) };
    const actual = inventory(destination); delete actual[".presence-guard-stage.json"];
    if (m.version !== 1 || m.commit !== commit || m.upstream !== UPSTREAM || m.sourceHash !== hash(JSON.stringify(canonical)) || JSON.stringify(m.files) !== JSON.stringify(expected) || JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("staging_not_canonical_reviewed_source");
    return m;
}
export function stage(project, vencord, dryRun = false, io = fs) {
    const gitRoot = execFileSync("git", ["-C", vencord, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    if (resolve(gitRoot) !== resolve(vencord)) throw Error("staging_requires_vencord_git_root");
    const gitDirectory = execFileSync("git", ["-C", vencord, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    // Resolve only the Git directory: --git-path canonicalizes a symlink at the receipt itself.
    const receiptPath = join(gitDirectory, "presence-guard-stage.json");
    const destination = join(resolve(vencord), "src/userplugins/presenceGuard");
    recoverStage(destination, receiptPath, inventory, dryRun, io);
    const commit = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const source = join(project, "src"), files = inventory(source);
    const sourceHash = hash(JSON.stringify(files));
    const previous = { files: null, receipt: null };
    if (existsSync(destination)) {
        if (lstatSync(destination).isSymbolicLink()) throw Error("unexpected_staging_symlink");
        const marker = join(destination, ".presence-guard-stage.json");
        if (!existsSync(marker)) throw Error("unowned_staging_directory");
        const markerBytes = regularBytes(marker), old = JSON.parse(markerBytes), actual = inventory(destination);
        previous.files = { ...actual };
        if (existsSync(receiptPath)) {
            if (lstatSync(receiptPath).isSymbolicLink()) throw Error("staging_receipt_symlink");
            previous.receipt = regularBytes(receiptPath, "utf8");
            const receipt = JSON.parse(previous.receipt);
            if (receipt.version !== 1 || receipt.markerHash !== hash(markerBytes) || receipt.commit !== old.commit || receipt.sourceHash !== old.sourceHash) throw Error("staging_receipt_drift");
        } else {
            // A legacy tree may be attested only when every byte matches current canonical source.
            verifyStaged(project, destination, old.commit);
        }
        delete actual[".presence-guard-stage.json"];
        if (JSON.stringify(actual) !== JSON.stringify(old.files)) throw Error("staged_source_drift");
    }
    else if (existsSync(receiptPath)) throw Error("staging_tree_missing_receipt_preserved");
    // Reject predictable receipt failures before replacing the previously verified tree.
    let receiptStat;
    try { receiptStat = lstatSync(receiptPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (receiptStat && (!receiptStat.isFile() || receiptStat.isSymbolicLink() || !(receiptStat.mode & 0o222))) throw Error("staging_receipt_not_writable_regular_file");
    if (receiptStat) accessSync(receiptPath, constants.W_OK);
    const receiptParent = lstatSync(dirname(receiptPath));
    if (!receiptParent.isDirectory() || receiptParent.isSymbolicLink() || !(receiptParent.mode & 0o222)) throw Error("staging_receipt_parent_not_writable");
    accessSync(dirname(receiptPath), constants.W_OK);
    if (dryRun) return { destination, commit, sourceHash, files: Object.keys(files).length };
    replaceStage(destination, receiptPath, inventory, temporary => {
        io.cpSync(source, temporary, { recursive: true, errorOnExist: true });
        io.writeFileSync(join(temporary, "buildInfo.ts"), buildInfo(source, commit));
        const manifest = { version: 1, commit, upstream: UPSTREAM, sourceHash, files: inventory(temporary) };
        const markerBytes = JSON.stringify(manifest, null, 2);
        io.writeFileSync(join(temporary, ".presence-guard-stage.json"), markerBytes, { mode: 0o600 });
        if (hash(JSON.stringify(inventory(source))) !== sourceHash) throw Error("canonical_source_changed_during_staging");
        return JSON.stringify({ version: 1, markerHash: hash(markerBytes), commit, sourceHash });
    }, previous, io);
    return { destination, commit, sourceHash, files: Object.keys(files).length };
}
