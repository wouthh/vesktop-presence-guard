/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Status } from "./types";

/** Attribute Idle only to the exact local automatic-Idle path while Online is configured. */
export function isNativeAutomaticIdle(configured: Status, nativeEligible: boolean, localIdle: boolean) {
    return configured === "online" && nativeEligible && localIdle;
}
