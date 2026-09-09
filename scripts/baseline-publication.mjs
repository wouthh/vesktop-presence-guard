// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname } from "node:path";
import { regularBytes } from "./regular-file.mjs";
import { syncDirectory } from "./stage-transaction.mjs";

const present = path => { try { return fs.lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
function publish(path, bytes, io) {
    const temp = `${path}.${randomUUID()}.new`;
    const fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
        io.writeFileSync(fd, bytes); io.fchmodSync(fd, 0o600); io.fsyncSync(fd);
        // Atomic, exclusive publication preserves any unexpected existing target.
        io.linkSync(temp, path); syncDirectory(dirname(path), io);
    } finally { io.closeSync(fd); io.unlinkSync(temp); }
}
export function publishBaseline(manifest, anchor, bytes, validate, io = fs) {
    const journal = `${anchor}.publication`;
    if (!present(journal)) {
        if (present(manifest) || present(anchor) || typeof bytes !== "string") throw Error("initial_baseline_publication_drift");
        validate(JSON.parse(bytes));
        publish(journal, JSON.stringify({ version: 1, manifest, anchor, bytes }), io);
    }
    const tx = JSON.parse(regularBytes(journal, "utf8", 1024 * 1024));
    if (tx.version !== 1 || tx.manifest !== manifest || tx.anchor !== anchor || typeof tx.bytes !== "string") throw Error("invalid_baseline_publication");
    // Independently compare the recorded baseline with the still-active original
    // release and verified backups before completing either missing target.
    validate(JSON.parse(tx.bytes));
    const digest = createHash("sha256").update(tx.bytes).digest("hex") + "\n";
    const targets = [[manifest, tx.bytes], [anchor, digest]];
    const check = () => {
        for (const [path, expected] of targets) {
            const stat = present(path);
            if (stat && ((stat.mode & 0o7777) !== 0o600 || regularBytes(path, "utf8", 1024 * 1024) !== expected)) throw Error("baseline_publication_target_drift");
        }
    };
    check();
    for (const [path, expected] of targets) if (!present(path)) publish(path, expected, io);
    check();
    for (const [path] of targets) syncDirectory(dirname(path), io);
    io.unlinkSync(journal); syncDirectory(dirname(journal), io);
}
