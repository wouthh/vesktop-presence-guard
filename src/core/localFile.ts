/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { constants } from "fs";
import { lstat, open, rename, unlink } from "fs/promises";

interface AtomicIO {
    lstat(path: string): Promise<{ isFile(): boolean }>;
    open(path: string, flags: number, mode: number): Promise<{ writeFile(data: string): Promise<unknown>; sync(): Promise<void>; close(): Promise<void> }>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
}

export async function boundedLocalJson(path: string, max = 1024 * 1024) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await fd.stat();
        if (!stat.isFile()) throw Error("not_regular_file");
        if (stat.size > max) throw Error("file_too_large");
        const b = Buffer.alloc(max + 1);
        const { bytesRead } = await fd.read(b, 0, b.length, 0);
        if (bytesRead > max) throw Error("file_too_large");
        return JSON.parse(b.subarray(0, bytesRead).toString("utf8"));
    } finally { await fd.close(); }
}

// Native-only implementation; this is not exported as a renderer IPC operation.
export async function atomicLocalFile(destination: string, data: unknown, io: AtomicIO = { lstat, open, rename, unlink }) {
    const stat = await io.lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat && !stat.isFile()) throw Error("unsafe_local_file_target");
    const temp = `${destination}.${randomUUID()}.tmp`;
    const file = await io.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let closed = false;
    try {
        await file.writeFile(JSON.stringify(data));
        await file.sync();
        await file.close(); closed = true;
        await io.rename(temp, destination);
    } finally {
        if (!closed) await file.close().catch(() => {});
        await io.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
}
