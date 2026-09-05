// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbidden = [/\/home\/[a-z][\w.-]*\//i, /(?:mfa\.[\w-]{30,}|gh[pousr]_[\w]{25,})/, /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/, /\b\d{17,20}\b/];
for (const file of files) {
    if (/^(?:\.cache|dist|node_modules)\//.test(file)) continue;
    if (/history\.json|installation\.json|diagnostics\.json|discord-web\.js|\.asar$/.test(file)) throw Error(`private artifact tracked: ${file}`);
    const text = readFileSync(file, "utf8");
    if (forbidden.some(re => re.test(text))) throw Error(`privacy pattern in ${file}; inspect locally before publishing`);
}
console.log(`Privacy scan passed for ${files.length} source files (manual diff review still required).`);
