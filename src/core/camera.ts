/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { fresh, type Signal,UNKNOWN } from "./types";
type PW = { id: number; type: string; info?: { cookie?: number; state?: string; props?: Record<string, unknown>; "output-node-id"?: number; "input-node-id"?: number } };
const scope = "Partial: PipeWire hardware webcam capture; direct V4L2 not covered";
export class PipeWireDetector {
    // Stable serial -> numeric ID, retained until that exact capture is cleared.
    private active = new Map<number, number>();
    private cookie: number | undefined;
    private lostCapture = false;
    reset() { this.active.clear(); this.cookie = undefined; this.lostCapture = false; }
    parse(text: string, at: number): Signal {
        let objects: PW[];
        try {
            if (text.length > 4 * 1024 * 1024) throw Error();
            const data: unknown = JSON.parse(text);
            if (!Array.isArray(data) || data.length > 20_000 || data.some(x => !x || typeof x !== "object" || !Number.isInteger(x.id) || typeof x.type !== "string")) throw Error();
            objects = data as PW[];
        } catch { return UNKNOWN(scope, "pipewire_malformed", at); }
        const cookie = objects.find(o => o.type === "PipeWire:Interface:Core")?.info?.cookie;
        if (!Number.isInteger(cookie)) return UNKNOWN(scope, "pipewire_identity_unavailable", at);
        if (this.cookie !== undefined && cookie !== this.cookie) { this.lostCapture ||= this.active.size > 0; this.active.clear(); }
        this.cookie = cookie;
        const nodes = new Map(objects.filter(o => o.type === "PipeWire:Interface:Node").map(o => [o.id, o]));
        const cameras = [...nodes.values()].filter(n => {
            const p = n.info?.props;
            return p?.["media.class"] === "Video/Source" && p["device.api"] === "v4l2" && p["api.v4l2.cap.driver"] === "uvcvideo" && p["node.virtual"] !== true && p["node.virtual"] !== "true";
        });
        if (cameras.some(c => !Number.isSafeInteger(c.info?.props?.["object.serial"]))) return UNKNOWN(scope, "camera_identity_unavailable", at);
        const active = new Map<number, number>();
        for (const camera of cameras) {
            if (camera.info?.state !== "running") continue;
            const capture = objects.some(link => {
                if (link.type !== "PipeWire:Interface:Link" || link.info?.state !== "active" || link.info["output-node-id"] !== camera.id) return false;
                const consumer = nodes.get(link.info["input-node-id"]!);
                return consumer?.info?.state === "running" && consumer.info.props?.["media.class"] === "Stream/Input/Video";
            });
            if (capture) active.set(camera.info!.props!["object.serial"] as number, camera.id);
        }
        for (const [serial, id] of this.active) {
            if (cameras.some(c => c.id === id && c.info?.props?.["object.serial"] === serial && ["idle", "suspended"].includes(c.info?.state ?? ""))) this.active.delete(serial);
        }
        for (const [serial, id] of active) {
            if (this.active.size >= 20_000 && !this.active.has(serial)) return UNKNOWN(scope, "camera_continuity_capacity", at);
            this.active.set(serial, id);
        }
        if (active.size) { this.lostCapture = false; return { value: "active", at, scope, reason: "running_hardware_camera_linked_to_capture" }; }
        if (this.lostCapture) return UNKNOWN(scope, "capture_provider_restarted", at);
        // Missing previously observed cameras may mean visibility changed, not that capture stopped.
        if ([...this.active].some(([serial, id]) => !cameras.some(c => c.id === id && c.info?.props?.["object.serial"] === serial))) return UNKNOWN(scope, "previous_camera_missing", at);
        if (cameras.some(c => !["idle", "suspended"].includes(c.info?.state ?? ""))) return UNKNOWN(scope, "camera_graph_ambiguous", at);
        if (!cameras.length) return UNKNOWN(scope, "no_visible_supported_camera", at);
        this.active.clear();
        return { value: "inactive", at, scope, reason: "no_capture_in_pipewire_scope" };
    }
}

export function combineCamera(pipewire: Signal, local: Signal, now: number): Signal {
    const scope = "Partial: observed Vesktop camera streams and PipeWire UVC capture";
    const active = [pipewire, local].filter(s => fresh(s, now) && s.value === "active");
    if (active.length) return { value: "active", at: Math.max(...active.map(s => s.at)), scope, reason: "confirmed_capture_in_supported_scope" };
    // Unavailable coverage is not a negative observation. In particular, a lost local stream cannot release DND.
    if ([pipewire, local].some(s => !fresh(s, now))) return UNKNOWN(scope, "camera_provider_unknown", now);
    return { value: "inactive", at: Math.min(pipewire.at, local.at), scope, reason: "capture_clear_in_observed_scopes" };
}

export function cameraSnapshot(pipewire: Signal, local: Signal, now: number, continuous: boolean): Signal {
    return continuous ? combineCamera(pipewire, local, now) : UNKNOWN("Partial", "renderer_restart_required_for_webcam_rule", now);
}
