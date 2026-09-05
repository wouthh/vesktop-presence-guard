/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { constants } from "fs";
import { open, rename, unlink } from "fs/promises";

interface AtomicIO {
    open(path: string, flags: number, mode: number): Promise<{ writeFile(data: string): Promise<unknown>; sync(): Promise<void>; close(): Promise<void> }>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
}

// Native-only implementation; this is not exported as a renderer IPC operation.
export async function atomicLocalFile(destination: string, data: unknown, io: AtomicIO = { open, rename, unlink }) {
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
