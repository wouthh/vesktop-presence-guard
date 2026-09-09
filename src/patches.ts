/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
// These are structural fingerprints, not copied Discord source fixtures.
export const actionPatch = {
    find: /async function \w+\(\w+\)\{let\{nextStatus:\w+,prevStatus:/,
    replacement: {
        match: /async function (\w+)\((\w+)\)\{(?=let\{nextStatus:)/,
        replace: "async function $1($2){$self.statusAction($2);"
    }
};
export const protoPatch = {
    find: "async updateAsync(",
    replacement: {
        match: /(async updateAsync\((\w+),(\w+),(\w+),(\w+)\)\{[\s\S]*?)(null!=([\w]+)&&\(__OVERLAY__\?)/,
        replace: "$1$self.generatedUpdate($3,$7);$6"
    }
};
export const selectionPatch = {
    find: /let\{status:\w+,currentStatus:\w+,description:/,
    group: true,
    replacement: [{
        match: /function (\w+)\((\w+)\)\{(?=let\{status:\w+,currentStatus:\w+,description:)/,
        replace: "$self.manualProviderReady();function $1($2){"
    }, {
        match: /\{nextStatus:\w+,prevStatus:\w+(?:,durationMillis:\w+)?\}/g,
        replace: "$self.manualOptions($&)"
    }]
};
// Observe successful application-owned acquisition, without invoking getUserMedia ourselves.
export const cameraPatch = {
    find: /acquire\(\w+\)\{return navigator\.mediaDevices\.getUserMedia/,
    group: true,
    replacement: [{
        match: /class (\w+)\{acquire\((\w+)\)\{return navigator\.mediaDevices\.getUserMedia/,
        replace: "class $1{static presenceGuard=$self.cameraProviderReady();acquire($2){return navigator.mediaDevices.getUserMedia"
    }, {
        match: /return navigator\.mediaDevices\.getUserMedia\((\w+)\)/,
        replace: "return navigator.mediaDevices.getUserMedia($1).then(s=>($self.cameraAcquired($1,s),s))"
    }]
};
