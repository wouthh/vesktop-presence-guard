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
export const saveLifecyclePatch = {
    find: "async updateAsync(",
    group: true,
    replacement: [{
        match: /markDirty\((\w+),(\w+)\)\{/,
        replace: "markDirty($1,$2){$self.saveQueued(this,$1);"
    }, {
        match: /(persistChanges=async\(\)=>\{[\s\S]*?let\{editInfo:(\w+)\}=this\.getEditInfo\(\);if\(null==\2\.protoToSave\)return void [^;]+;)/,
        replace: "$1const presenceGuardSave=$self.saveStarted(this,$2.protoToSave);"
    }, {
        match: /let (\w+)=((?:\(0,\w+\.\w+\)\(this\.ProtoClass,\w+\.settings\)));if\(null==\1\)return;(\w+\.h\.dispatch\(\{type:"USER_SETTINGS_PROTO_UPDATE",settings:\{proto:\1,type:this\.type\},resetEditInfo:!0,wasSaved:!0,local:!1\}\))/,
        replace: "let $1=$2;if(null==$1){$self.saveUnavailable(this,presenceGuardSave);return;}$self.saveSucceeded(this,presenceGuardSave,$1);$3"
    }, {
        match: /persistChanges=async\(\)=>\{[\s\S]*?\}catch\((\w+)\)\{/,
        replace: "$&$self.saveFailed(this,presenceGuardSave,$1?.status===429?\"rate_limited\":\"terminal\");"
    }]
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

// This narrows changes to Discord's local automatic IDLE store event. It leaves
// input timestamps, AFK calculations, notifications and other presence logic intact.
export const nativeIdlePatch = {
    find: 'type:"IDLE",idle:!0,idleSince:',
    replacement: {
        match: /Date\.now\(\)-(\w+)>(\w+)\.(\w+)\|\|(\w+)\(\)\?(\w+)\|\|(\w+)\.h\.dispatch\(\{type:"IDLE",idle:!0,idleSince:(\w+)\}\):\5&&\6\.h\.dispatch\(\{type:"IDLE",idle:!1\}\)/,
        replace: "$self.nativeIdleProviderReady(()=>{const wanted=$self.nativeIdleDecision(Date.now()-$1>$2.$3||$4());const current=$self.nativeIdleCurrent();$self.nativeIdleObserved(wanted,current);if(wanted&&!current){$self.nativeIdleDispatch(true);$6.h.dispatch({type:\"IDLE\",idle:!0,idleSince:$7})}else if(!wanted&&current){$self.nativeIdleDispatch(false);$6.h.dispatch({type:\"IDLE\",idle:!1})}});$self.nativeIdleDecision(Date.now()-$1>$2.$3||$4())?$5||($self.nativeIdleDispatch(true),$6.h.dispatch({type:\"IDLE\",idle:!0,idleSince:$7})):$5&&($self.nativeIdleDispatch(false),$6.h.dispatch({type:\"IDLE\",idle:!1}))"
    }
};
