// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { hash, inventory } from "./staging.mjs";
import { regularBytes } from "./regular-file.mjs";
import { syncDirectory } from "./stage-transaction.mjs";

export const integrationPaths = c => ({
    launcher: c.mainLauncher, updater: c.updater,
    settings: join(c.mainProfile, "settings/settings.json"),
    helper: join(c.vencordRoot, ".presence-guard/display-helper.mjs"),
    helperConfig: join(c.mainProfile, "PresenceGuard/installation.json"),
    lease: join(c.mainProfile, "PresenceGuard/lease.json"),
    launcherReceipt: join(c.ledger, "installed-launcher.sha256"), updaterReceipt: join(c.ledger, "installed-updater.sha256"),
    installed: join(c.ledger, "installed.json"), rolledBack: join(c.ledger, "rolled-back.json")
});
const journalPath = c => join(c.ledger, "integration-transaction.json");
const descriptorHash = c => hash(JSON.stringify(Object.fromEntries(["vencordRoot", "mainProfile", "altProfile", "mainLauncher", "updater", "updaterLock", "updaterPending", "ledger"].map(key => [key, c[key] ?? null]))));
const present = path => { try { return fs.lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const imagePath = (path, id) => join(dirname(path), `.${basename(path)}.presence-guard-${id}.image`);
function state(path) {
    const stat = present(path);
    if (stat && stat.mode & 0o7000) throw Error("unexpected_special_permission_bits");
    return stat ? { hash: hash(regularBytes(path)), mode: stat.mode & 0o7777 } : null;
}
export const snapshotIntegrationTargets = c => Object.fromEntries(Object.entries(integrationPaths(c)).map(([key, path]) => [key, state(path)]));
function retained(c, path) {
    const root = fs.realpathSync(join(c.vencordRoot, ".wout-releases"));
    if (typeof path !== "string" || dirname(dirname(path)) !== root || basename(path) !== "dist" || fs.realpathSync(path) !== path) throw Error("transaction_release_outside_retained_root");
    return { path, files: inventory(path) };
}
function durable(path, bytes, mode, io) {
    const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { io.writeFileSync(fd, bytes); io.fchmodSync(fd, mode); io.fsyncSync(fd); }
    catch (error) { io.unlinkSync(path); throw error; }
    finally { io.closeSync(fd); }
}
export function pendingIntegration(c) {
    if (!present(journalPath(c))) return null;
    const tx = JSON.parse(regularBytes(journalPath(c), "utf8", 1024 * 1024));
    if (tx.version !== 1 || !["install", "rollback"].includes(tx.kind) || !/^[a-f0-9-]{36}$/.test(tx.id) || !/^[a-f0-9]{40}$/.test(tx.commit) || !Array.isArray(tx.files) || !tx.files.length || tx.files.length > 9 || new Set(tx.files.map(f => f.key)).size !== tx.files.length) throw Error("invalid_integration_transaction");
    const paths = integrationPaths(c);
    if (tx.descriptorHash !== descriptorHash(c)) throw Error("integration_descriptor_drift");
    if (!same(Object.keys(tx.guards ?? {}), tx.kind === "install" ? ["updater", "updaterReceipt"] : ["updaterReceipt"])) throw Error("invalid_integration_guards");
    for (const file of tx.files) {
        if (!Object.hasOwn(paths, file.key)) throw Error("invalid_integration_target");
        for (const s of [file.before, file.after]) if (s !== null && (!s || !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isInteger(s.mode) || s.mode < 0 || s.mode > 0o777)) throw Error("invalid_integration_file_state");
    }
    return tx;
}
export function prepareIntegration(c, kind, commit, afterDist, changes, io = fs) {
    if (present(journalPath(c))) throw Error("integration_recovery_required");
    if (!["install", "rollback"].includes(kind) || !/^[a-f0-9]{40}$/.test(commit)) throw Error("invalid_integration_identity");
    const paths = integrationPaths(c), id = randomUUID(), created = [];
    const guards = Object.fromEntries((kind === "install" ? ["updater", "updaterReceipt"] : ["updaterReceipt"]).map(key => [key, state(paths[key])]));
    if (Object.values(guards).some(value => !value)) throw Error("integration_wiring_missing");
    const tx = { version: 1, kind, commit, id, descriptorHash: descriptorHash(c), guards, beforeDist: retained(c, fs.realpathSync(join(c.vencordRoot, "dist"))), afterDist: retained(c, afterDist), files: [] };
    try {
        for (const change of changes) {
            const { key, data, mode = 0o600 } = change;
            if (!Object.hasOwn(paths, key) || tx.files.some(f => f.key === key)) throw Error("invalid_integration_target");
            if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw Error("invalid_integration_mode");
            const path = paths[key], before = state(path);
            if (Object.hasOwn(change, "expectedBefore") && !same(before, change.expectedBefore)) throw Error("integration_preflight_target_drift");
            io.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const parent = io.lstatSync(dirname(path));
            if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("unsafe_integration_parent");
            const after = data === null ? null : { hash: hash(data), mode };
            if (data !== null) {
                const image = imagePath(path, id); durable(image, data, mode, io); created.push(image);
                syncDirectory(dirname(path), io);
            }
            tx.files.push({ key, before, after });
        }
        // Preparing images can take time: do not adopt edits made in the meantime.
        for (const file of tx.files) if (!same(state(paths[file.key]), file.before)) throw Error("integration_target_changed_during_preparation");
        const journalImage = join(c.ledger, `.integration-transaction-${id}.new`);
        durable(journalImage, JSON.stringify(tx), 0o600, io); created.push(journalImage);
        io.renameSync(journalImage, journalPath(c)); created.pop(); syncDirectory(c.ledger, io);
        return tx;
    } catch (error) {
        if (!present(journalPath(c))) for (const image of created) io.unlinkSync(image);
        throw error;
    }
}
function validate(c, tx) {
    if (tx.descriptorHash !== descriptorHash(c)) throw Error("integration_descriptor_drift");
    for (const [key, expected] of Object.entries(tx.guards)) if (!same(state(integrationPaths(c)[key]), expected)) throw Error("integration_wiring_drift");
    if (!same(retained(c, tx.afterDist.path), tx.afterDist)) throw Error("integration_candidate_drift");
    const current = fs.realpathSync(join(c.vencordRoot, "dist"));
    if (current !== tx.beforeDist.path && current !== tx.afterDist.path) throw Error("integration_active_release_drift");
    if (current === tx.beforeDist.path && !same(retained(c, current), tx.beforeDist)) throw Error("integration_previous_release_drift");
    const paths = integrationPaths(c);
    for (const file of tx.files) {
        const path = paths[file.key], parent = fs.lstatSync(dirname(path));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("unsafe_integration_parent");
        const current = state(path);
        if (!same(current, file.before) && !same(current, file.after)) throw Error("integration_target_drift");
        if (file.after && !same(state(imagePath(path, tx.id)), file.after)) throw Error("integration_prepared_image_drift");
    }
    return current;
}
// Repeating the interrupted action finishes its authenticated prepared result.
// A rollback request can discard an installation that never reached activation.
export function finishIntegration(c, tx, activate, cancelUnactivated = false, io = fs) {
    const current = validate(c, tx), paths = integrationPaths(c);
    const untouched = tx.files.every(file => same(state(paths[file.key]), file.before));
    if (cancelUnactivated && tx.kind === "install" && current === tx.beforeDist.path && current !== tx.afterDist.path && untouched) {
        io.unlinkSync(journalPath(c)); syncDirectory(c.ledger, io);
        for (const file of tx.files) if (file.after) io.unlinkSync(imagePath(paths[file.key], tx.id));
        return { cancelled: true, kind: tx.kind, commit: tx.commit };
    }
    if (current !== tx.afterDist.path && !untouched) throw Error("integration_release_reverted_after_file_changes");
    if (current !== tx.afterDist.path) {
        if (tx.kind === "install") activate(tx.afterDist.path);
        else {
            const link = join(c.vencordRoot, `.dist.presence-guard-${tx.id}`);
            if (present(link)) {
                if (!io.lstatSync(link).isSymbolicLink() || io.readlinkSync(link) !== tx.afterDist.path) throw Error("integration_temporary_link_drift");
            } else io.symlinkSync(tx.afterDist.path, link);
            io.renameSync(link, join(c.vencordRoot, "dist"));
        }
        syncDirectory(c.vencordRoot, io);
    }
    if (fs.realpathSync(join(c.vencordRoot, "dist")) !== tx.afterDist.path) throw Error("integration_activation_mismatch");
    validate(c, tx);
    for (const file of tx.files) {
        const path = paths[file.key];
        if (!same(state(path), file.after)) {
            if (file.after === null) { if (present(path)) io.unlinkSync(path); }
            else {
                const image = imagePath(path, tx.id), temp = `${image}.apply`;
                if (present(temp)) { if (!same(state(temp), file.after)) throw Error("integration_apply_image_drift"); }
                else io.linkSync(image, temp);
                io.renameSync(temp, path);
            }
            syncDirectory(dirname(path), io);
        }
    }
    // Keep the journal until every target and the active build have been checked.
    validate(c, tx);
    for (const file of tx.files) if (!same(state(paths[file.key]), file.after)) throw Error("integration_not_complete");
    io.unlinkSync(journalPath(c)); syncDirectory(c.ledger, io);
    for (const file of tx.files) if (file.after) io.unlinkSync(imagePath(paths[file.key], tx.id));
    return { cancelled: false, kind: tx.kind, commit: tx.commit };
}
