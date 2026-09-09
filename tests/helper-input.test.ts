// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildSync } from "esbuild";

test("GJS helper reads only the validated descriptor and rejects FIFO, symlink and oversized inputs", { skip: !existsSync("/usr/bin/gjs") }, t => {
    const root = mkdtempSync(join(tmpdir(), "presence-guard-gjs-input-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const normal = join(root, "normal"), fifo = join(root, "fifo"), oversized = join(root, "oversized");
    writeFileSync(normal, "original"); writeFileSync(oversized, "x".repeat(65537)); execFileSync("/usr/bin/mkfifo", [fifo]);
    const module = join(root, "read.mjs");
    buildSync({ entryPoints: [resolve("helper/read-input.ts")], outfile: module, bundle: true, format: "esm", external: ["gi://*"] });
    const code = `import GLib from "gi://GLib"; import Gio from "gi://Gio"; import {readHelperInput} from "./read.mjs";
      const [normal,fifo,oversized]=ARGV;
      function rejects(path){try{readHelperInput(path);}catch{return;}throw Error("unexpected_success");}
      rejects(fifo); rejects(oversized);
      Gio.File.new_for_path(normal+".link").make_symbolic_link(normal,null); rejects(normal+".link");
      const open=GLib.open;
      GLib.open=(path,flags,mode)=>{const fd=open(path,flags,mode); if(path===normal){GLib.rename(normal,normal+".saved");GLib.rename(fifo,normal);}return fd;};
      if(readHelperInput(normal)!=="original")throw Error("replacement_was_read");
      if(!readHelperInput("/proc/self/stat"))throw Error("proc_read_failed");
      print("descriptor-safe");`;
    const runner = join(root, "test.mjs"); writeFileSync(runner, code);
    assert.match(execFileSync("/usr/bin/gjs", ["-m", runner, normal, fifo, oversized], { encoding: "utf8", timeout: 3000 }), /descriptor-safe/);
});
