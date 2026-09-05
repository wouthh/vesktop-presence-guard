// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { regularBytes } from "./regular-file.mjs";

const present = path => { try { return fs.lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function syncDirectory(path, io = fs) {
    const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function durableFile(path, bytes, io) {
    const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); }
    catch (e) { io.unlinkSync(path); throw e; }
    finally { io.closeSync(fd); }
}
const paths = (_destination, receipt, id) => ({ next: join(dirname(receipt), `.presence-guard-next-${id}`), previous: join(dirname(receipt), `.presence-guard-previous-${id}`), receiptNext: `${receipt}.${id}.next`, journal: `${receipt}.transaction`, journalNext: `${receipt}.transaction.${id}.next` });

// Called only under the staging/updater lock. Recovery validates all generations
// before removing any generated tree; unexplained drift remains untouched.
export function recoverStage(destination, receipt, inventory, dry = false, io = fs) {
    const journal = `${receipt}.transaction`;
    if (!present(journal)) return;
    if (dry) throw Error("staging_recovery_required_run_stage");
    const tx = JSON.parse(regularBytes(journal, "utf8", 1024 * 1024));
    if (tx.version !== 1 || !/^[a-f0-9-]{36}$/.test(tx.id) || typeof tx.nextReceipt !== "string" || !(tx.previousReceipt === null || typeof tx.previousReceipt === "string")) throw Error("invalid_staging_transaction");
    const p = paths(destination, receipt, tx.id);
    const trees = {};
    for (const [key, path] of Object.entries({ current: destination, next: p.next, previous: p.previous })) {
        const stat = present(path);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error("staging_recovery_tree_type");
        trees[key] = stat ? inventory(path) : null;
    }
    const receiptNow = present(receipt) ? regularBytes(receipt, "utf8") : null;
    if (![tx.previousReceipt, tx.nextReceipt].includes(receiptNow)) throw Error("staging_recovery_receipt_drift");
    if (present(p.receiptNext) && regularBytes(p.receiptNext, "utf8") !== tx.nextReceipt) throw Error("staging_recovery_temporary_receipt_drift");
    if (trees.next && !equal(trees.next, tx.nextFiles)) throw Error("staging_recovery_next_drift");
    if (trees.previous && !equal(trees.previous, tx.previousFiles)) throw Error("staging_recovery_previous_drift");
    const committed = receiptNow === tx.nextReceipt && equal(trees.current, tx.nextFiles);
    if (receiptNow === tx.nextReceipt && receiptNow !== tx.previousReceipt && !committed) throw Error("staging_recovery_committed_drift");
    if (!committed && trees.previous) {
        if (trees.current && !equal(trees.current, tx.nextFiles)) throw Error("staging_recovery_current_drift");
    } else if (!committed && !equal(trees.current, tx.previousFiles) && !(tx.previousFiles === null && equal(trees.current, tx.nextFiles))) throw Error("staging_recovery_original_missing");
    // All paths and contents are checked before the first recovery mutation.
    if (!committed && trees.previous) {
        if (trees.current) io.rmSync(destination, { recursive: true });
        io.renameSync(p.previous, destination);
    } else if (!committed && tx.previousFiles === null && trees.current) io.rmSync(destination, { recursive: true });
    syncDirectory(dirname(destination), io); syncDirectory(dirname(receipt), io);
    io.unlinkSync(journal); syncDirectory(dirname(receipt), io);
    for (const path of [p.next, p.previous]) if (present(path)) io.rmSync(path, { recursive: true });
    if (present(p.receiptNext)) io.unlinkSync(p.receiptNext);
}

export function replaceStage(destination, receipt, inventory, build, expected, io = fs) {
    const id = randomUUID(), p = paths(destination, receipt, id);
    io.mkdirSync(dirname(destination), { recursive: true });
    if (fs.statSync(dirname(destination)).dev !== fs.statSync(dirname(receipt)).dev) throw Error("staging_requires_same_filesystem_git_metadata");
    io.mkdirSync(p.next, { mode: 0o700 });
    let journalReady = false;
    let journalImageReady = false;
    try {
        const nextReceipt = build(p.next);
        const nextFiles = inventory(p.next);
        const directories = new Set([p.next]);
        for (const file of Object.keys(nextFiles)) {
            const path = join(p.next, file), fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
            let directory = dirname(path);
            while (directory !== dirname(p.next)) { directories.add(directory); directory = dirname(directory); }
        }
        for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory, io);
        durableFile(p.receiptNext, nextReceipt, io); syncDirectory(dirname(receipt), io); syncDirectory(dirname(destination), io);
        const previousFiles = present(destination) ? inventory(destination) : null;
        const previousReceipt = present(receipt) ? regularBytes(receipt, "utf8") : null;
        if (!equal(previousFiles, expected.files) || previousReceipt !== expected.receipt) throw Error("staging_changed_during_preparation");
        durableFile(p.journalNext, JSON.stringify({ version: 1, id, nextFiles, previousFiles, nextReceipt, previousReceipt }), io); journalImageReady = true;
        io.renameSync(p.journalNext, p.journal);
        syncDirectory(dirname(receipt), io); journalReady = true;
        if (previousFiles) { io.renameSync(destination, p.previous); syncDirectory(dirname(destination), io); syncDirectory(dirname(receipt), io); }
        io.renameSync(p.next, destination); syncDirectory(dirname(destination), io); syncDirectory(dirname(receipt), io);
        io.renameSync(p.receiptNext, receipt); syncDirectory(dirname(receipt), io);
        recoverStage(destination, receipt, inventory, false, io);
    } catch (error) {
        // Once journaled, retain both generations for the next locked retry.
        if (!journalReady && !present(p.journal)) {
            if (present(p.next)) io.rmSync(p.next, { recursive: true });
            if (present(p.receiptNext)) io.unlinkSync(p.receiptNext);
            if (journalImageReady && present(p.journalNext)) io.unlinkSync(p.journalNext);
        }
        throw error;
    }
}
