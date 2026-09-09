// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { actionPatch, cameraPatch, protoPatch, selectionPatch } from "../src/patches";
const source = readFileSync(process.argv[2], "utf8");
if (source.length > 40 * 1024 * 1024) throw Error("client_source_too_large");
const ast = ts.createSourceFile("client.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const modules: string[] = [];
function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name && /^\d+$/.test(node.name.getText(ast))) modules.push(node.getText(ast).replace(/^\d+\(/, "function("));
    else ts.forEachChild(node, visit);
}
visit(ast);
for (const [name, patch] of Object.entries({ actionPatch, protoPatch, selectionPatch, cameraPatch })) {
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
