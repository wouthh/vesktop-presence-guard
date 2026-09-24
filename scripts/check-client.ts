// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { actionPatch, cameraPatch, nativeIdlePatch, protoPatch, saveLifecyclePatch, selectionPatch } from "../src/patches";
const source = readFileSync(process.argv[2], "utf8");
if (source.length > 40 * 1024 * 1024) throw Error("client_source_too_large");
const preloadedName = 'discord_protos.discord_users.v1.PreloadedUserSettings';
const statusName = 'discord_protos.discord_users.v1.StatusSettings';
const preloadedAt = source.indexOf(`super("${preloadedName}"`);
if (preloadedAt < 0) throw Error("status_updater_preloaded_proto_missing");
const preloadedSchema = source.slice(preloadedAt, preloadedAt + 12_000);
const rootStatus = preloadedSchema.match(/\{no:11,name:"status",kind:"message",T:\(\)=>([\w$]+)\}/);
if (!rootStatus) throw Error("status_updater_root_status_descriptor_changed");
const statusAt = source.indexOf(`super("${statusName}"`);
if (statusAt < 0) throw Error("status_settings_proto_missing");
const statusSchema = source.slice(statusAt, statusAt + 2_000);
if (!/\{no:1,name:"status",kind:"message",T:\(\)=>[\w$.]+\}/.test(statusSchema)) throw Error("status_settings_value_descriptor_changed");
if (!source.slice(statusAt, statusAt + 15_000).includes(`let ${rootStatus[1]}=`)) throw Error("preloaded_status_field_identity_changed");
const statusUpdates = [...source.matchAll(/updateAsync\("status",/g)].map(match => source.slice(match.index, match.index! + 1_200));
if (!statusUpdates.some(snippet => /\.status=[\w$.]+\.create\(\{value:\w+\}\)/.test(snippet))) throw Error("configured_status_update_path_changed");
console.log("status updater: PreloadedUserSettings type, root status field, nested StatusSettings field, and configured picker write path verified");
const ast = ts.createSourceFile("client.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const modules: string[] = [];
function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name && /^\d+$/.test(node.name.getText(ast))) modules.push(node.getText(ast).replace(/^\d+\(/, "function("));
    else ts.forEachChild(node, visit);
}
visit(ast);
for (const [name, patch] of Object.entries({ actionPatch, protoPatch, saveLifecyclePatch, selectionPatch, cameraPatch, nativeIdlePatch })) {
    const matches = modules.filter(code => typeof patch.find === "string" ? code.includes(patch.find) : patch.find.test(code));
    if (matches.length !== 1) throw Error(`${name}: expected one module, got ${matches.length}`);
    let code = matches[0];
    for (const replacement of Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]) {
        const next = code.replace(replacement.match, replacement.replace);
        if (next === code) throw Error(`${name}: replacement did not match`);
        code = next;
    }
    // Compile only; never evaluate the application code or call status/media functions.
    new Function(`return (${code});`);
    console.log(`${name}: unique module, all replacements matched, syntax valid`);
}
