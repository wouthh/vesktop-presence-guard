// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, inventory, stage, verifyStaged } from "./staging.mjs";
import { compileHelper } from "./helper-build.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(readFileSync(path, "utf8"));
const shellQuote = s => `'${s.replaceAll("'", "'\\''")}'`;
export const PARENT_START_AWK = '{sub(/^.*\\) /, ""); print $20}';
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
    const expected = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const m = verifyStaged(project, root, expected);
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
function backupHashes(c) {
    const result = {};
    for (const name of ["main-launcher", "updater", "main-plugins"]) {
        const path = join(c.ledger, "backups", name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error("unsafe_backup");
        if (name === "main-plugins" && (!read(path)?.plugins || typeof read(path).plugins !== "object" || Array.isArray(read(path).plugins))) throw Error("malformed_backup_settings");
        result[name] = hash(readFileSync(path));
    }
    return result;
}
function statOrNull(path) { try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
export function writableTarget(path, allowMissing = false) {
    const stat = statOrNull(path);
    if (!stat && !allowMissing) throw Error("required_target_missing");
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error("unsafe_target_file");
    if (stat && !(stat.mode & 0o222)) throw Error("target_not_writable");
    if (stat) accessSync(path, constants.R_OK | constants.W_OK);
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !(parent.mode & 0o222)) throw Error("unsafe_target_parent");
    accessSync(dirname(path), constants.W_OK);
}
function readSettings(c) {
    const path = join(c.mainProfile, "settings/settings.json"); writableTarget(path);
    const value = read(path);
    if (!value || typeof value !== "object" || Array.isArray(value) || !value.plugins || typeof value.plugins !== "object" || Array.isArray(value.plugins)) throw Error("malformed_plugin_settings");
    return value;
}
export function planSettings(c) { return enableMain(readSettings(c)); }
export function preflightRollback(c) {
    for (const path of [c.mainLauncher, c.updater]) writableTarget(path);
    for (const path of [join(c.mainProfile, "PresenceGuard/lease.json"), join(c.ledger, "rolled-back.json")]) writableTarget(path, true);
    const root = lstatSync(c.vencordRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error("unsafe_vencord_root");
    accessSync(c.vencordRoot, constants.W_OK);
    return readSettings(c);
}
export function pinBaseline(c) {
    const root = join(c.vencordRoot, ".presence-guard"), path = join(root, "baseline.json");
    if (!existsSync(path) && existsSync(join(c.ledger, "installed.json"))) throw Error("installed_baseline_missing");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
        const dist = realpathSync(join(c.vencordRoot, "dist"));
        if (!dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !dist.endsWith("/dist")) throw Error("baseline_not_retained_release");
        atomic(path, JSON.stringify({ dist, files: inventory(dist), backups: backupHashes(c) }));
    }
    const baseline = read(path);
    if (typeof baseline.dist !== "string" || !baseline.dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !baseline.dist.endsWith("/dist") || realpathSync(baseline.dist) !== baseline.dist) throw Error("baseline_path_drift");
    if (JSON.stringify(inventory(baseline.dist)) !== JSON.stringify(baseline.files)) throw Error("baseline_build_drift");
    const backups = backupHashes(c);
    if (!baseline.backups && !existsSync(join(c.ledger, "installed.json"))) { baseline.backups = backups; atomic(path, JSON.stringify(baseline)); }
    if (JSON.stringify(baseline.backups) !== JSON.stringify(backups)) throw Error("backup_drift");
    return baseline;
}
export function planHelper(c) {
    const root = join(c.vencordRoot, ".presence-guard"), native = join(c.mainProfile, "PresenceGuard");
    for (const path of [root, native]) {
        const stat = statOrNull(path);
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error("helper_directory_drift");
        accessSync(stat ? path : dirname(path), constants.W_OK);
    }
    writableTarget(c.mainLauncher);
    for (const name of ["installed-launcher.sha256", "installed.json"]) writableTarget(join(c.ledger, name), true);
    accessSync(c.ledger, constants.W_OK);
    if (existsSync(native)) writableTarget(join(native, "helper.log"), true);
    const configPath = join(native, "installation.json");
    if (existsSync(configPath) && (lstatSync(configPath).isSymbolicLink() || read(configPath).snapshot !== join(root, "display.json") || read(configPath).version !== 1)) throw Error("helper_configuration_drift");
    const helperPath = join(root, "display-helper.mjs"), receipt = join(c.ledger, "installed.json");
    const helperStat = statOrNull(helperPath), hasReceipt = existsSync(receipt);
    if (hasReceipt && !existsSync(configPath)) throw Error("installed_helper_configuration_missing");
    if (!hasReceipt && statOrNull(configPath)) throw Error("unowned_helper_configuration");
    if (Boolean(helperStat) !== hasReceipt || (helperStat && (!helperStat.isFile() || helperStat.isSymbolicLink() || hash(readFileSync(helperPath)) !== read(receipt).helperHash))) throw Error("installed_helper_drift");
    const launcher = readFileSync(c.mainLauncher, "utf8");
    const marker = "# PresenceGuard process-bound observer";
    const installed = join(c.ledger, "installed-launcher.sha256");
    if (launcher.includes(marker)) {
        if (!existsSync(installed) || readFileSync(installed, "utf8").trim() !== hash(launcher)) throw Error("launcher_drift");
        return { root, native, configPath, launcher };
    }
    const lines = launcher.trimEnd().split("\n");
    if (!lines.at(-1).startsWith("exec ") || !lines.at(-1).includes("mullvad-exclude") || !lines.at(-1).includes("flatpak run")) throw Error("unsupported_launcher_shape_preserved");
    const launch = lines.pop();
    const injection = `${marker}\npg_start=$(awk ${shellQuote(PARENT_START_AWK)} /proc/$$/stat)\n/usr/bin/gjs -m ${shellQuote(join(root, "display-helper.mjs"))} "$$" "$pg_start" ${shellQuote(join(root, "display.json"))} ${shellQuote(join(native, "lease.json"))} >> ${shellQuote(join(native, "helper.log"))} 2>&1 &\n`;
    const next = `${lines.join("\n")}\n${injection}${launch}\n`;
    return { root, native, configPath, launcher: next };
}
function setupHelper(c, plan, helper) {
    const { root, native, configPath, launcher } = plan;
    mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(native, { recursive: true, mode: 0o700 });
    atomic(join(root, "display-helper.mjs"), helper);
    if (!existsSync(configPath)) atomic(configPath, JSON.stringify({ version: 1, snapshot: join(root, "display.json"), welcome: true }));
    atomic(c.mainLauncher, launcher, 0o755);
    atomic(join(c.ledger, "installed-launcher.sha256"), `${hash(launcher)}\n`);
}
export async function main(args) {
    const action = args[0], path = args[args.indexOf("--config") + 1];
    if (!args.includes("--config") || !path) throw Error("use --config with an owner-only installation descriptor");
    const c = descriptor(resolve(path)), dry = args.includes("--dry-run");
    const locked = args.includes("--locked");
    const underLock = (childArgs = args) => { mkdirSync(dirname(c.updaterLock), { recursive: true, mode: 0o700 }); return execFileSync("/usr/bin/flock", ["-n", c.updaterLock, process.execPath, fileURLToPath(import.meta.url), ...childArgs, "--locked"], { stdio: "inherit" }); };
    if (action === "inspect") return console.log(JSON.stringify(inspect(c), null, 2));
    if (action === "stage") { if (!dry && !locked) return underLock(); return console.log(JSON.stringify(stage(project, c.vencordRoot, dry), null, 2)); }
    if (action === "prepare") {
        if (dry) return console.log(JSON.stringify(stage(project, c.vencordRoot, true)));
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), "stage", "--config", path], { stdio: "inherit" }); execFileSync(c.updater, ["rebuild"], { stdio: "inherit" }); return;
    }
    if (action === "pin" && locked) { verifyWiring(c); pinBaseline(c); return; }
    if (!["install", "update", "rollback", "uninstall"].includes(action)) throw Error("unknown_install_action");
    if (dry) {
        if (action === "install" || action === "update") { planSettings(c); planHelper(c); }
        return console.log(JSON.stringify({ action, ...inspect(c), changes: ["main plugin settings", "main helper launcher", "retained build activation"], restarts: "Both profiles must be gracefully closed by the operator; no implicit termination." }, null, 2));
    }
    if (processes().length) throw Error("vesktop_running_close_identified_profiles_gracefully_after_call_capture_preflight");
    const settingsPath = join(c.mainProfile, "settings/settings.json");
    if (action === "install" || action === "update") {
        const manifest = verifyCandidate(c);
        // The maintained updater owns its own lock, candidate checks, backups and atomic activation.
        verifyWiring(c);
        const settings = planSettings(c);
        const plan = planHelper(c);
        const helper = compileHelper(project);
        if (!locked) {
            underLock(["pin", "--config", path]);
            execFileSync(c.updater, ["activate"], { stdio: "inherit" }); return underLock();
        }
        const active = realpathSync(join(c.vencordRoot, "dist"));
        for (const file of ["vencordDesktopMain.js", "vencordDesktopRenderer.js"]) {
            const text = readFileSync(join(active, file), "utf8");
            if (!text.includes("PresenceGuard") || (file.includes("Renderer") && !text.includes(manifest.commit))) throw Error("active_build_identity_mismatch");
        }
        setupHelper(c, plan, helper);
        atomic(settingsPath, JSON.stringify(settings));
        const receipt = { commit: manifest.commit, helperHash: hash(helper), installedAt: new Date().toISOString(), dist: active, rendererHash: hash(readFileSync(join(active, "vencordDesktopRenderer.js"))), mainHash: hash(readFileSync(join(active, "vencordDesktopMain.js"))) };
        atomic(join(c.ledger, "installed.json"), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify(receipt, null, 2));
        return;
    }
    // Restore the pinned, hash-verified retained release, independent of later update history.
    if (!locked) return underLock();
    const rolledBack = join(c.ledger, "rolled-back.json");
    if (!existsSync(join(c.ledger, "installed.json"))) throw Error("no_installation_receipt");
    const currentSettings = preflightRollback(c);
    const baseline = pinBaseline(c);
    if (existsSync(rolledBack)) {
        if (realpathSync(join(c.vencordRoot, "dist")) !== baseline.dist || hash(readFileSync(c.mainLauncher)) !== hash(readFileSync(join(c.ledger, "backups/main-launcher"))) || hash(readFileSync(c.updater)) !== hash(readFileSync(join(c.ledger, "backups/updater")))) throw Error("rollback_drift");
        return console.log("Previous integration is already restored; history retained.");
    }
    verifyWiring(c);
    const settings = restoreMain(currentSettings, read(join(c.ledger, "backups/main-plugins")));
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
