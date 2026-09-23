/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ConfiguredUpdateEvidence {
    hasConfiguredStatus: boolean;
    changed: boolean;
    local?: boolean;
    partial?: boolean;
    wasSaved?: boolean;
    pluginLocalUpdate: boolean;
    correlatedPluginSave: boolean;
    matchedManualSelection: boolean;
}

/** Detect an observable configured-setting mutation without inferring from presence events. */
export function isConfiguredIntervention(e: ConfiguredUpdateEvidence) {
    if (!e.hasConfiguredStatus || !e.changed || e.pluginLocalUpdate || e.correlatedPluginSave || e.matchedManualSelection) return false;
    if (e.local === true) return e.partial === true;
    return e.partial === true || e.local === false && e.wasSaved === true;
}
