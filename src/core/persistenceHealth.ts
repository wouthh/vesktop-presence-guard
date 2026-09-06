/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type Operation = "history_read" | "history_write" | "history_clear" | "diagnostics";
export class PersistenceHealth {
    private failures = new Set<Operation>();
    get summary() { return [...this.failures].map(name => `${name}_failed`).join(", ") || "healthy"; }
    async run<T>(name: Operation, work: () => Promise<T>): Promise<T> {
        try { const result = await work(); this.failures.delete(name); return result; }
        catch (error) { this.failures.add(name); throw error; }
    }
    async diagnostics(work: () => Promise<unknown>): Promise<void> {
        // Diagnostic persistence must never invalidate independently acquired signals.
        await this.run("diagnostics", work).catch(() => {});
    }
}
