// SPDX-License-Identifier: GPL-3.0-or-later
import { fstatSync, lstatSync, readdirSync, readFileSync } from "node:fs";

export function exclusiveLockDescriptor(path) {
    const target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink()) return undefined;
    return readdirSync("/proc/self/fdinfo").find(fd => {
        try {
            const stat = fstatSync(Number(fd));
            if (stat.dev !== target.dev || stat.ino !== target.ino) return false;
            return new RegExp(`^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s`, "m").test(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
        } catch { return false; /* Descriptor closed during inspection. */ }
    });
}
export const holdsExclusiveLock = path => exclusiveLockDescriptor(path) !== undefined;
