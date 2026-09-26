/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function ownershipTransitionDiagnostic(value: unknown): { ownershipTransitionAt?: number } {
    return typeof value === "number" && Number.isFinite(value) ? { ownershipTransitionAt: value } : {};
}
