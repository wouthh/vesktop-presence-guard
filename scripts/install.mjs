// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, inventory, stage } from "./staging.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(readFileSync(path, "utf8"));
const shellQuote = s => `'${s.replaceAll("'", "'\\''")}'`;
function atomic(path, value, mode = 0o600) {
    const temp = `${path}.${process.pid}.new`;
    writeFileSync(temp, value, { mode, flag: "wx" }); renameSync(temp, path);
}
export function processes() {
    const result = [];
    for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
            if (cmd.startsWith("/app/bin/vesktop/vesktop.bin") && !cmd.includes("--type=")) result.push(Number(pid));
        } catch { /* Exited or inaccessible process. */ }
    }
    return result;
}
export function descriptor(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error("descriptor_must_be_private_regular_file");
    const c = read(path);
    for (const key of ["vencordRoot", "mainProfile", "altProfile", "mainLauncher", "updater", "updaterLock", "ledger"]) if (typeof c[key] !== "string" || !isAbsolute(c[key])) throw Error(`invalid_${key}`);
    if (realpathSync(c.mainProfile) === realpathSync(c.altProfile)) throw Error("profiles_must_be_distinct");
    const state = read(join(c.mainProfile, "state.json"));
    if (state.vencordDir !== join(c.vencordRoot, "dist")) throw Error("main_profile_not_using_managed_dist");
    return c;
}
export function inspect(c) {
    const settings = read(join(c.mainProfile, "settings/settings.json"));
    const marker = join(c.vencordRoot, "src/userplugins/presenceGuard/.presence-guard-stage.json");
    return { running: processes(), activeBuild: realpathSync(join(c.vencordRoot, "dist")), plugin: settings.plugins?.PresenceGuard ?? null, stagedCommit: existsSync(marker) ? read(marker).commit : null, existingSources: readdirSync(join(c.vencordRoot, "src/userplugins")).sort() };
}
function verifyCandidate(c) {
    const root = join(c.vencordRoot, "src/userplugins/presenceGuard");
    const m = read(join(root, ".presence-guard-stage.json")), files = inventory(root); delete files[".presence-guard-stage.json"];
    if (JSON.stringify(m.files) !== JSON.stringify(files)) throw Error("staging_drift");
    const expected = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (m.commit !== expected) throw Error("staged_commit_mismatch");
    const dirty = execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" });
    if (dirty) throw Error("commit_and_validate_project_before_installation");
    return m;
}
export function enableMain(settings) {
    const next = structuredClone(settings);
    next.plugins ??= {};
    next.plugins.PresenceGuard = { observe: true, idle: false, camera: false, ...next.plugins.PresenceGuard, enabled: true };
    return next;
}
export function restoreMain(current, before) {
    const next = structuredClone(current); next.plugins ??= {};
    if (before.plugins?.PresenceGuard) next.plugins.PresenceGuard = structuredClone(before.plugins.PresenceGuard);
    else delete next.plugins.PresenceGuard;
    return next;
}
export function verifyWiring(c) {
    for (const [key, backup, receipt] of [["mainLauncher", "main-launcher", "installed-launcher.sha256"], ["updater", "updater", "installed-updater.sha256"]]) {
        const record = join(c.ledger, receipt);
        const expected = existsSync(record) ? readFileSync(record, "utf8").trim() : hash(readFileSync(join(c.ledger, "backups", backup)));
        if (hash(readFileSync(c[key])) !== expected) throw Error(`${key}_drift`);
    }
}
export function pinBaseline(c) {
    const root = join(c.vencordRoot, ".presence-guard"); mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "baseline.json");
    if (!existsSync(path)) {
        const dist = realpathSync(join(c.vencordRoot, "dist"));
        if (!dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !dist.endsWith("/dist")) throw Error("baseline_not_retained_release");
        atomic(path, JSON.stringify({ dist, files: inventory(dist) }));
    }
    const baseline = read(path);
    if (typeof baseline.dist !== "string" || !baseline.dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !baseline.dist.endsWith("/dist") || realpathSync(baseline.dist) !== baseline.dist) throw Error("baseline_path_drift");
    if (JSON.stringify(inventory(baseline.dist)) !== JSON.stringify(baseline.files)) throw Error("baseline_build_drift");
    return baseline;
}
function setupHelper(c) {
    const root = join(c.vencordRoot, ".presence-guard"), native = join(c.mainProfile, "PresenceGuard");
    mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(native, { recursive: true, mode: 0o700 });
    const helper = readFileSync(join(project, "dist/display-helper.mjs"));
    atomic(join(root, "display-helper.mjs"), helper);
    const configPath = join(native, "installation.json");
    if (!existsSync(configPath)) atomic(configPath, JSON.stringify({ version: 1, snapshot: join(root, "display.json"), welcome: true }));
    else if (read(configPath).snapshot !== join(root, "display.json")) throw Error("helper_configuration_drift");
    const launcher = readFileSync(c.mainLauncher, "utf8");
    const marker = "# PresenceGuard process-bound observer";
    const installed = join(c.ledger, "installed-launcher.sha256");
    if (launcher.includes(marker)) {
        if (!existsSync(installed) || readFileSync(installed, "utf8").trim() !== hash(launcher)) throw Error("launcher_drift");
        return;
    }
    const lines = launcher.trimEnd().split("\n");
    if (!lines.at(-1).startsWith("exec ") || !lines.at(-1).includes("mullvad-exclude") || !lines.at(-1).includes("flatpak run")) throw Error("unsupported_launcher_shape_preserved");
    const launch = lines.pop();
    const injection = `${marker}\npg_start=$(awk '{print $22}' /proc/$$/stat)\n/usr/bin/gjs -m ${shellQuote(join(root, "display-helper.mjs"))} "$$" "$pg_start" ${shellQuote(join(root, "display.json"))} ${shellQuote(join(native, "lease.json"))} >> ${shellQuote(join(native, "helper.log"))} 2>&1 &\n`;
    const next = `${lines.join("\n")}\n${injection}${launch}\n`;
    atomic(c.mainLauncher, next, 0o755);
    atomic(installed, `${hash(next)}\n`);
}
export async function main(args) {
    const action = args[0], path = args[args.indexOf("--config") + 1];
    if (!args.includes("--config") || !path) throw Error("use --config with an owner-only installation descriptor");
    const c = descriptor(resolve(path)), dry = args.includes("--dry-run");
    const locked = args.includes("--locked");
    const underLock = () => execFileSync("/usr/bin/flock", ["-n", c.updaterLock, process.execPath, fileURLToPath(import.meta.url), ...args, "--locked"], { stdio: "inherit" });
    if (action === "inspect") return console.log(JSON.stringify(inspect(c), null, 2));
    if (action === "stage") { if (!dry && !locked) return underLock(); return console.log(JSON.stringify(stage(project, c.vencordRoot, dry), null, 2)); }
    if (action === "prepare") {
        if (dry) return console.log(JSON.stringify(stage(project, c.vencordRoot, true)));
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), "stage", "--config", path], { stdio: "inherit" }); execFileSync(c.updater, ["rebuild"], { stdio: "inherit" }); return;
    }
    if (action === "pin" && locked) { verifyWiring(c); pinBaseline(c); return; }
    if (!["install", "update", "rollback", "uninstall"].includes(action)) throw Error("unknown_install_action");
    if (dry) return console.log(JSON.stringify({ action, ...inspect(c), changes: ["main plugin settings", "main helper launcher", "retained build activation"], restarts: "Both profiles must be gracefully closed by the operator; no implicit termination." }, null, 2));
    if (processes().length) throw Error("vesktop_running_close_identified_profiles_gracefully_after_call_capture_preflight");
    const settingsPath = join(c.mainProfile, "settings/settings.json");
    if (action === "install" || action === "update") {
        const manifest = verifyCandidate(c);
        // The maintained updater owns its own lock, candidate checks, backups and atomic activation.
        verifyWiring(c);
        if (!locked) {
            execFileSync("/usr/bin/flock", ["-n", c.updaterLock, process.execPath, fileURLToPath(import.meta.url), "pin", "--config", path, "--locked"], { stdio: "inherit" });
            execFileSync(c.updater, ["activate"], { stdio: "inherit" }); return underLock();
        }
        const active = realpathSync(join(c.vencordRoot, "dist"));
        for (const file of ["vencordDesktopMain.js", "vencordDesktopRenderer.js"]) {
            const text = readFileSync(join(active, file), "utf8");
            if (!text.includes("PresenceGuard") || (file.includes("Renderer") && !text.includes(manifest.commit))) throw Error("active_build_identity_mismatch");
        }
        setupHelper(c);
        atomic(settingsPath, JSON.stringify(enableMain(read(settingsPath))));
        const receipt = { commit: manifest.commit, installedAt: new Date().toISOString(), dist: active, rendererHash: hash(readFileSync(join(active, "vencordDesktopRenderer.js"))), mainHash: hash(readFileSync(join(active, "vencordDesktopMain.js"))) };
        atomic(join(c.ledger, "installed.json"), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify(receipt, null, 2));
        return;
    }
    // Restore the pinned, hash-verified retained release, independent of later update history.
    if (!locked) return underLock();
    const rolledBack = join(c.ledger, "rolled-back.json");
    const baseline = pinBaseline(c);
    if (existsSync(rolledBack)) {
        if (realpathSync(join(c.vencordRoot, "dist")) !== baseline.dist || hash(readFileSync(c.mainLauncher)) !== hash(readFileSync(join(c.ledger, "backups/main-launcher"))) || hash(readFileSync(c.updater)) !== hash(readFileSync(join(c.ledger, "backups/updater")))) throw Error("rollback_drift");
        return console.log("Previous integration is already restored; history retained.");
    }
    verifyWiring(c);
    const settings = restoreMain(read(settingsPath), read(join(c.ledger, "backups/main-plugins")));
    const current = realpathSync(join(c.vencordRoot, "dist"));
    const receipt = read(join(c.ledger, "installed.json"));
    if (current !== receipt.dist || hash(readFileSync(join(current, "vencordDesktopRenderer.js"))) !== receipt.rendererHash || hash(readFileSync(join(current, "vencordDesktopMain.js"))) !== receipt.mainHash) throw Error("active_build_changed_since_installation");
    const link = join(c.vencordRoot, `.dist.presence-guard-${process.pid}`);
    symlinkSync(baseline.dist, link); renameSync(link, join(c.vencordRoot, "dist"));
    atomic(c.mainLauncher, readFileSync(join(c.ledger, "backups/main-launcher")), 0o755);
    atomic(settingsPath, JSON.stringify(settings));
    atomic(join(c.mainProfile, "PresenceGuard/lease.json"), JSON.stringify({ enabled: false, at: Date.now() }));
    atomic(c.updater, readFileSync(join(c.ledger, "backups/updater")), 0o755);
    atomic(rolledBack, JSON.stringify({ at: new Date().toISOString(), dist: baseline.dist }));
    console.log("Previous integration restored; local history and unrelated settings retained. Relaunch the previous profiles normally.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
