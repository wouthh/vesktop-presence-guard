/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Only lifecycle metadata; never stop a track or access frames.
export interface CameraTrack {
    readyState: string;
    muted: boolean;
    enabled: boolean;
    addEventListener(type: "ended", fn: () => void, options: { once: boolean }): void;
    removeEventListener(type: "ended", fn: () => void): void;
}
export class CameraTracks {
    private entries = new Map<CameraTrack, () => void>();
    constructor(private changed: () => void) {}
    get size() { return this.entries.size; }
    get live() { return [...this.entries.keys()].some(t => t.readyState === "live" && !t.muted && t.enabled); }
    add(track: CameraTrack) {
        if (this.entries.has(track)) return;
        const ended = () => { this.remove(track); this.changed(); };
        this.entries.set(track, ended); track.addEventListener("ended", ended, { once: true });
    }
    private remove(track: CameraTrack) {
        const fn = this.entries.get(track);
        if (fn) track.removeEventListener("ended", fn);
        this.entries.delete(track);
    }
    prune() { for (const track of this.entries.keys()) if (track.readyState === "ended") this.remove(track); }
    clear() { for (const track of this.entries.keys()) this.remove(track); }
}
