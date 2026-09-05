// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Production JavaScript tooling is linted and tested directly.
import { publishBaseline } from "../scripts/baseline-publication.mjs";
function fixture(t: any) {
    const root = fs.mkdtempSync(join(tmpdir(), "presence-guard-baseline-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = join(root, "manifest"), anchor = join(root, "anchor"), bytes = JSON.stringify({ original: "synthetic immutable release" });
    const validate = (value: unknown) => assert.deepEqual(value, JSON.parse(bytes));
    return { manifest, anchor, bytes, validate };
}
for (const operation of ["writeFileSync", "fsyncSync", "linkSync", "unlinkSync"]) test(`initial baseline publication recovers each ${operation} failure`, t => {
    const p = fixture(t); let total = 0;
    publishBaseline(p.manifest, p.anchor, p.bytes, p.validate, { ...fs, [operation]: (...args: any[]) => { total++; return (fs as any)[operation](...args); } });
    for (let fail = 1; fail <= total; fail++) {
        const f = fixture(t); let count = 0;
        assert.throws(() => publishBaseline(f.manifest, f.anchor, f.bytes, f.validate, { ...fs, [operation]: (...args: any[]) => { if (++count === fail) throw Error("interrupted"); return (fs as any)[operation](...args); } }), /interrupted/);
        if (fs.existsSync(f.anchor + ".publication") || !fs.existsSync(f.anchor)) publishBaseline(f.manifest, f.anchor, f.bytes, f.validate);
        assert.equal(fs.readFileSync(f.manifest, "utf8"), f.bytes); assert.match(fs.readFileSync(f.anchor, "utf8"), /^[a-f0-9]{64}\n$/);
        assert.equal(fs.existsSync(f.anchor + ".publication"), false);
    }
});
test("initial baseline recovery preserves changed targets and rejects a changed original state", t => {
    const f = fixture(t); let links = 0;
    assert.throws(() => publishBaseline(f.manifest, f.anchor, f.bytes, f.validate, { ...fs, linkSync: (...args: any[]) => { if (++links === 3) throw Error("interrupted"); return (fs.linkSync as any)(...args); } }), /interrupted/);
    assert.throws(() => publishBaseline(f.manifest, f.anchor, undefined, () => { throw Error("original_changed"); }), /original_changed/);
    fs.writeFileSync(f.manifest, "unexplained edit");
    assert.throws(() => publishBaseline(f.manifest, f.anchor, undefined, f.validate), /target_drift/);
    assert.equal(fs.readFileSync(f.manifest, "utf8"), "unexplained edit"); assert.equal(fs.existsSync(f.anchor), false);
});
test("a pending initial publication repairs either missing output after persistence loss", t => {
    for (const missing of ["manifest", "anchor"] as const) {
        const f = fixture(t);
        assert.throws(() => publishBaseline(f.manifest, f.anchor, f.bytes, f.validate, { ...fs, unlinkSync: (path: string) => { if (path === f.anchor + ".publication") throw Error("interrupted"); fs.unlinkSync(path); } }), /interrupted/);
        fs.unlinkSync(f[missing]);
        publishBaseline(f.manifest, f.anchor, undefined, f.validate);
        assert.equal(fs.readFileSync(f.manifest, "utf8"), f.bytes); assert.match(fs.readFileSync(f.anchor, "utf8"), /^[a-f0-9]{64}\n$/);
    }
});
