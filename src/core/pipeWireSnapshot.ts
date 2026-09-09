/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type Selector = "0" | "PipeWire:Interface:Node" | "PipeWire:Interface:Link";
type ObjectInfo = { id: number; type: string; info?: { cookie?: number; state?: string; props?: Record<string, unknown>; "input-node-id"?: number; "output-node-id"?: number } };
const nodeKeys = ["object.serial", "media.class", "device.api", "api.v4l2.cap.driver", "node.virtual"];

/** Avoid unrelated Port parameters that older pw-dump versions cannot serialize.
 * Bracket the link observation with stable node identities/states and core identity.
 * Only detector fields leave this function; no application names or media data.
 */
export async function pipeWireGraph(query: (selector: Selector, timeout: number, maxBytes: number) => Promise<string | null>, now = Date.now): Promise<string | null> {
    const start = now();
    let bytes = 0;
    async function read(selector: Selector, type: string) {
        const remaining = 2000 - (now() - start);
        if (remaining <= 0 || remaining > 2000 || bytes >= 4 * 1024 * 1024) throw Error();
        const raw = await query(selector, remaining, 4 * 1024 * 1024 - bytes);
        if (raw === null || (bytes += new TextEncoder().encode(raw).byteLength) > 4 * 1024 * 1024 || now() - start >= 2000 || now() < start) throw Error();
        const rows: ObjectInfo[] = JSON.parse(raw);
        if (!Array.isArray(rows) || rows.length > 20_000 || rows.some(o => !o || !Number.isSafeInteger(o.id) || o.id < 0 || o.type !== type || !o.info) || new Set(rows.map(o => o.id)).size !== rows.length) throw Error();
        return rows.sort((a, b) => a.id - b.id);
    }
    async function core() {
        const rows = await read("0", "PipeWire:Interface:Core");
        if (rows.length !== 1 || rows[0].id !== 0 || !Number.isSafeInteger(rows[0].info?.cookie)) throw Error();
        return { id: 0, type: "PipeWire:Interface:Core", info: { cookie: rows[0].info!.cookie } };
    }
    async function nodes() {
        return (await read("PipeWire:Interface:Node", "PipeWire:Interface:Node")).map(o => {
            const info = o.info!;
            if (typeof info.state !== "string" || !Number.isSafeInteger(info.props?.["object.serial"])) throw Error();
            return { id: o.id, type: o.type, info: { state: info.state, props: Object.fromEntries(nodeKeys.filter(k => info.props?.[k] !== undefined).map(k => [k, info.props![k]])) } };
        });
    }
    try {
        const before = await core(), first = await nodes();
        const links = (await read("PipeWire:Interface:Link", "PipeWire:Interface:Link")).map(o => {
            const info = o.info!;
            if (typeof info.state !== "string" || !Number.isSafeInteger(info["input-node-id"]) || !Number.isSafeInteger(info["output-node-id"])) throw Error();
            return { id: o.id, type: o.type, info: { state: info.state, "input-node-id": info["input-node-id"], "output-node-id": info["output-node-id"] } };
        });
        const second = await nodes(), after = await core();
        if (before.info.cookie !== after.info.cookie || JSON.stringify(first) !== JSON.stringify(second)) return null;
        const rows = [after, ...second, ...links];
        if (new Set(rows.map(o => o.id)).size !== rows.length) return null;
        return JSON.stringify(rows);
    } catch { return null; }
}
