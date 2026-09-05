// SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function regularBytes(path, encoding, max = 4 * 1024 * 1024) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > max) throw Error("unsafe_regular_file");
        const buffer = Buffer.alloc(stat.size + 1), count = readSync(fd, buffer, 0, buffer.length, 0);
        if (count !== stat.size) throw Error("file_changed_during_read");
        return encoding ? buffer.subarray(0, count).toString(encoding) : buffer.subarray(0, count);
    } finally { closeSync(fd); }
}
