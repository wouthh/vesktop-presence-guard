/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { execFile } from "child_process";
import { app, dialog, IpcMainInvokeEvent } from "electron";
import { constants } from "fs";
import { lstat, mkdir, open, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";

import { retain } from "./core/history";
import { atomicLocalFile } from "./core/localFile";
import { HistoryEvent, status } from "./core/types";

const directory = join(DATA_DIR, "PresenceGuard");
let queue: Promise<unknown> = Promise.resolve();
let pwBusy = false;
async function ready() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error("unsafe_history_directory");
}
async function bounded(path: string, max = 1024 * 1024) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if ((await fd.stat()).size > max) throw Error("file_too_large");
        const b = Buffer.alloc(max + 1);
        const { bytesRead } = await fd.read(b, 0, b.length, 0);
        if (bytesRead > max) throw Error("file_too_large");
        return JSON.parse(b.subarray(0, bytesRead).toString("utf8"));
    } finally { await fd.close(); }
}
async function atomic(name: string, data: unknown) {
    await ready();
    await atomicLocalFile(join(directory, name), data);
}
function serial<T>(f: () => Promise<T>): Promise<T> {
    const result = queue.then(f, f);
    queue = result.catch(() => undefined);
    return result;
}
function validEvent(event: unknown): event is HistoryEvent {
    if (!event || typeof event !== "object") return false;
    const e = event as HistoryEvent;
    return Number.isFinite(e.at) && typeof e.owned === "boolean" && ["observation", "request", "confirmation", "skip", "simulation", "error", "boundary"].includes(e.kind)
        && ["manual", "plugin", "native/client", "external", "unknown"].includes(e.source)
        && [e.previous, e.status, e.configured, e.aggregate].every(s => status(s) === s)
        && typeof e.reason === "string" && e.reason.length <= 240
        && [e.display, e.camera].every(s => s && ["active", "inactive", "unknown"].includes(s.value) && Number.isFinite(s.at) && typeof s.reason === "string" && s.reason.length <= 240 && typeof s.scope === "string" && s.scope.length <= 180)
        && JSON.stringify(e).length < 4096;
}
async function history(): Promise<HistoryEvent[]> {
    try {
        const data = await bounded(join(directory, "history.json"), 2 * 1024 * 1024);
        if (!Array.isArray(data) || !data.every(validEvent)) throw Error("malformed_history");
        const kept = retain(data, Date.now());
        if (kept.length !== data.length) await atomic("history.json", kept);
        return kept;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw Error("history_unavailable_preserved");
    }
}
export async function readHistory(_: IpcMainInvokeEvent) { return serial(history); }
export async function appendHistory(_: IpcMainInvokeEvent, event: HistoryEvent) {
    if (!validEvent(event)) throw Error("invalid_history_event");
    // Reconstruct fields to discard unknown renderer-supplied properties.
    const { at, kind, source, previous, status: current, configured, aggregate, reason, owned, display, camera } = event;
    const signal = (s: typeof display) => ({ at: s.at, value: s.value, reason: s.reason, scope: s.scope });
    return serial(async () => atomic("history.json", retain([...(await history()), { at, kind, source, previous, status: current, configured, aggregate, reason, owned, display: signal(display), camera: signal(camera) }], Date.now())));
}
export async function clearHistory(_: IpcMainInvokeEvent) { return serial(() => atomic("history.json", [])); }
export async function exportHistory(_: IpcMainInvokeEvent) {
    const events = await serial(history);
    const selection = await dialog.showSaveDialog({ title: "Export local PresenceGuard history", defaultPath: join(app.getPath("downloads"), `presence-guard-${Date.now()}.json`), filters: [{ name: "JSON", extensions: ["json"] }] });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(selection.filePath, JSON.stringify({ version: 1, note: "Local observations; not independent remote-presence proof", events }, null, 2), { mode: 0o600, flag: "wx" });
    return true;
}
export async function lease(_: IpcMainInvokeEvent, enabled: boolean) {
    if (typeof enabled !== "boolean") throw Error("invalid_lease");
    return serial(() => atomic("lease.json", { enabled, at: Date.now() }));
}
export async function displaySnapshot(_: IpcMainInvokeEvent) {
    try {
        const config = await bounded(join(directory, "installation.json"), 4096);
        if (typeof config.snapshot !== "string" || !isAbsolute(config.snapshot)) return null;
        const snapshot = await bounded(config.snapshot, 8192);
        if (snapshot.version !== 1 || !Number.isFinite(snapshot.at) || Date.now() < snapshot.at || Date.now() - snapshot.at > 10000) return null;
        return snapshot.observation ?? null;
    } catch { return null; }
}
export async function pipeWireSnapshot(_: IpcMainInvokeEvent): Promise<string | null> {
    if (pwBusy) return null;
    pwBusy = true;
    try {
        return await new Promise(resolve => execFile("/usr/bin/pw-dump", ["--no-colors"], { timeout: 2000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout)));
    } finally { pwBusy = false; }
}
export async function diagnostics(_: IpcMainInvokeEvent, value: unknown) {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 16384) throw Error("invalid_diagnostics");
    const v = value as Record<string, unknown>;
    // Fixed keys only. Account IDs and arbitrary renderer objects are never persisted here.
    const result: Record<string, unknown> = { at: Date.now() };
    for (const key of ["commit", "configured", "effective", "aggregate", "decision", "mode", "displayReason", "cameraReason", "patchError"]) {
        if (typeof v[key] === "string") result[key] = (v[key] as string).slice(0,240);
    }
    for (const key of ["enabled", "idle", "camera", "owned", "statusHooks", "cameraHook", "panelMounted", "voiceConnected", "localCameraLive"]) {
        result[key] = typeof v[key] === "boolean" ? v[key] : null;
    }
    await serial(() => atomic("diagnostics.json", result));
}

// The installer requests the panel once. This exposes no renderer-selected path or command.
export async function consumeWelcome(_: IpcMainInvokeEvent) {
    return serial(async () => {
        try {
            const config = await bounded(join(directory, "installation.json"), 4096);
            if (config.welcome !== true) return false;
            await atomic("installation.json", { ...config, welcome: false });
            return true;
        } catch { return false; }
    });
}
