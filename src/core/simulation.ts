/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import { PresenceEngine } from "./engine";
import type { HistoryEvent, Snapshot } from "./types";
export async function simulate(): Promise<string[]> {
    let now = 100000;
    let timer: (() => void) | null = null;
    const events: HistoryEvent[] = [];
    const s: Snapshot = { account: "simulation", connected: true, capable: true, configured: "online", effective: "online", aggregate: "online", nativeIdle: false, display: { value: "inactive", at: now, reason: "synthetic_blanking", scope: "SIMULATION" }, camera: { value: "inactive", at: now, reason: "synthetic_clear", scope: "SIMULATION" } };
    const engine = new PresenceEngine({ read: () => structuredClone(s), record: e => events.push(e), write: async (token, guard) => { if (guard()) { s.effective = s.configured = token.target; engine.sample("plugin", token); } } }, { now: () => now, set: fn => { timer = fn; return 1; }, clear: () => { timer = null; } }, { observe: true, idle: true, camera: true });
    async function step() {
        s.display.at = s.camera.at = now; engine.sample(); now += 2000;
        const fn = timer as (() => void) | null; timer = null; fn?.();
        for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    await step(); s.camera.value = "active"; await step(); s.camera.value = "inactive"; await step();
    engine.manual("idle"); s.display.value = "active"; await step(); engine.stop();
    return [...events.filter(e => e.kind === "confirmation").map(e => `SIMULATED local confirmation: ${e.status}`), `SIMULATED manual Idle then activity: ${s.effective}; owned: ${!!engine.ownership}`];
}
