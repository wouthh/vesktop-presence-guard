/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
import type { HistoryEvent } from "./types";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_EVENTS = 500;
export function retain(events: HistoryEvent[], now: number): HistoryEvent[] {
    return events.filter(e => Number.isFinite(e.at) && e.at <= now && e.at >= now - RETENTION_MS).slice(-MAX_EVENTS);
}
