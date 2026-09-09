// SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, constants, mkdtempSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { regularBytes } from "./regular-file.mjs";
import { hash } from "./staging.mjs";

export function pendingSnapshot(c, expectedDist) {
    if (typeof expectedDist !== "string" || !isAbsolute(expectedDist)) throw Error("expected_activation_release_required");
    const bytes = regularBytes(c.updaterPending);
    if (JSON.parse(bytes).release !== dirname(expectedDist)) throw Error("activation_pending_release_drift");
    // Give the reviewed updater an anonymous, read-only snapshot. Renaming or
    // editing pending.json after this point cannot substitute its activation input.
    const directory = mkdtempSync(join(c.ledger, ".pending-handoff-")), path = join(directory, "snapshot");
    let fd;
    try {
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        unlinkSync(path); rmdirSync(directory);
        return { fd, hash: hash(bytes), close: () => closeSync(fd) };
    } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(path); } catch { /* Creation may have failed. */ }
        try { rmdirSync(directory); } catch { /* Preserve unexpected files. */ }
        throw error;
    }
}
