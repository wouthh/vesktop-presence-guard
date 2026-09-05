// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, inventory, verifyStaged } from "./staging.mjs";
import { regularBytes, descriptorBytes } from "./regular-file.mjs";
import { exclusiveLockDescriptor as updaterLockDescriptor, holdsExclusiveLock as holdsUpdaterLock } from "./locks.mjs";
import { lockedStage } from "./locked-stage.mjs";
import { finishIntegration, pendingIntegration, prepareIntegration } from "./integration-transaction.mjs";
import { compileHelper } from "./helper-build.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(regularBytes(path, "utf8"));
const shellQuote = s => `'${s.replaceAll("'", "'\\''")}'`;
export const PARENT_START_AWK = '{sub(/^.*\\) /, ""); print $20}';
function atomic(path, value, mode = 0o600) {
    const temp = `${path}.${process.pid}.new`;
    writeFileSync(temp, value, { mode, flag: "wx" }); chmodSync(temp, mode); renameSync(temp, path);
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
    const pending = pendingIntegration(c);
    return { integrationRecovery: pending ? { kind: pending.kind, commit: pending.commit } : null, running: processes(), activeBuild: realpathSync(join(c.vencordRoot, "dist")), plugin: settings.plugins?.PresenceGuard ?? null, stagedCommit: existsSync(marker) ? read(marker).commit : null, existingSources: readdirSync(join(c.vencordRoot, "src/userplugins")).sort() };
}
function verifyCandidate(c) {
    const root = join(c.vencordRoot, "src/userplugins/presenceGuard");
    const expected = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const m = verifyStaged(project, root, expected);
    const dirty = execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" });
    if (dirty) throw Error("commit_and_validate_project_before_installation");
    return m;
}
export function enableMain(settings, update = false) {
    const next = structuredClone(settings);
    next.plugins ??= {};
    next.plugins.PresenceGuard = { observe: true, idle: false, camera: false, ...next.plugins.PresenceGuard, enabled: true };
    if (!update) Object.assign(next.plugins.PresenceGuard, { observe: true, idle: false, camera: false });
    return next;
}
export function restoreMain(current, before) {
    const next = structuredClone(current); next.plugins ??= {};
    if (before.plugins?.PresenceGuard) next.plugins.PresenceGuard = structuredClone(before.plugins.PresenceGuard);
    else delete next.plugins.PresenceGuard;
    return next;
}
export function verifyWiring(c) {
    const rolledBack = rollbackRecord(c);
    for (const [key, backup, receipt] of [["mainLauncher", "main-launcher", "installed-launcher.sha256"], ["updater", "updater", "installed-updater.sha256"]]) {
        const record = join(c.ledger, receipt);
        if (key === "updater" && !existsSync(record)) throw Error("required_updater_receipt_missing");
        if (key === "mainLauncher" && existsSync(join(c.ledger, "installed.json")) && !existsSync(record)) throw Error("required_launcher_receipt_missing");
        const expected = existsSync(record) && !(rolledBack && key === "mainLauncher") ? regularBytes(record, "utf8", 128).trim() : hash(regularBytes(join(c.ledger, "backups", backup)));
        if (!/^[a-f0-9]{64}$/.test(expected) || hash(regularBytes(c[key])) !== expected) throw Error(`${key}_drift`);
    }
    let modes;
    if (statOrNull(join(c.vencordRoot, ".presence-guard/baseline.json"))) modes = pinBaseline(c).modes;
    else { backupHashes(c); modes = originalModes(c); }
    for (const [key, mode] of [["mainLauncher", modes["main-launcher"]], ["updater", modes.updater]]) if ((lstatSync(c[key]).mode & 0o777) !== mode) throw Error(`${key}_mode_drift`);
    return { launcherMode: modes["main-launcher"], updaterMode: modes.updater };
}
export { exclusiveLockDescriptor as updaterLockDescriptor, holdsExclusiveLock as holdsUpdaterLock } from "./locks.mjs";
export function runUpdater(c, action, execute = execFileSync) {
    if (!["rebuild", "activate"].includes(action)) throw Error("unsupported_updater_action");
    const lock = updaterLockDescriptor(c.updaterLock);
    if (lock === undefined) throw Error("updater_lock_not_held");
    const wiring = verifyWiring(c);
    const fd = openSync(c.updater, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const expected = regularBytes(join(c.ledger, "installed-updater.sha256"), "utf8", 128).trim();
        if (hash(descriptorBytes(fd)) !== expected || (fstatSync(fd).mode & 0o777) !== wiring.updaterMode) throw Error("updater_descriptor_drift");
        // Linux preserves these inherited descriptors through the script's shebang.
        // The reviewed updater validates FD 4 against its lock before accepting it.
        return execute("/proc/self/fd/3", [action], { stdio: ["inherit", "inherit", "inherit", fd, Number(lock)], env: { ...process.env, PRESENCE_GUARD_LOCK_FD: "4" } });
    } finally { closeSync(fd); }
}
function backupHashes(c) {
    const result = {};
    for (const name of ["main-launcher", "updater", "main-plugins", "executable-modes.json"]) {
        const path = join(c.ledger, "backups", name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error("unsafe_backup");
        if (name === "main-plugins" && (!read(path)?.plugins || typeof read(path).plugins !== "object" || Array.isArray(read(path).plugins))) throw Error("malformed_backup_settings");
        result[name] = hash(regularBytes(path));
    }
    return result;
}
function originalModes(c) {
    const modes = read(join(c.ledger, "backups/executable-modes.json"));
    for (const key of ["main-launcher", "updater"]) if (!Number.isInteger(modes?.[key]) || modes[key] < 0 || modes[key] > 0o777 || (modes[key] & 0o500) !== 0o500) throw Error("invalid_original_executable_modes");
    return { "main-launcher": modes["main-launcher"], updater: modes.updater };
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
export function planSettings(c) { return enableMain(readSettings(c), Boolean(c.ledger && existsSync(join(c.ledger, "installed.json")) && !existsSync(join(c.ledger, "rolled-back.json")))); }
export function rollbackRecord(c) {
    const path = join(c.ledger, "rolled-back.json");
    if (!statOrNull(path)) return null;
    writableTarget(path);
    const record = read(path);
    if (record?.dist !== pinBaseline(c).dist || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) throw Error("rollback_receipt_drift");
    return record;
}
export function preflightRollback(c) {
    for (const path of [c.mainLauncher, c.updater]) writableTarget(path);
    for (const path of [join(c.mainProfile, "PresenceGuard/lease.json"), join(c.ledger, "rolled-back.json")]) writableTarget(path, true);
    const root = lstatSync(c.vencordRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error("unsafe_vencord_root");
    accessSync(c.vencordRoot, constants.W_OK);
    return readSettings(c);
}
export function restoreExecutables(c, baseline) {
    atomic(c.mainLauncher, regularBytes(join(c.ledger, "backups/main-launcher")), baseline.modes["main-launcher"]);
    atomic(c.updater, regularBytes(join(c.ledger, "backups/updater")), baseline.modes.updater);
}
export function pinBaseline(c) {
    const root = join(c.vencordRoot, ".presence-guard"), path = join(root, "baseline.json");
    const anchor = join(c.ledger, "baseline.sha256");
    writableTarget(anchor, true);
    if (!existsSync(path) && existsSync(join(c.ledger, "installed.json"))) throw Error("installed_baseline_missing");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writableTarget(path, true);
    if (!existsSync(path)) {
        if (existsSync(anchor)) throw Error("baseline_manifest_missing");
        const dist = realpathSync(join(c.vencordRoot, "dist"));
        if (!dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !dist.endsWith("/dist")) throw Error("baseline_not_retained_release");
        const bytes = JSON.stringify({ dist, files: inventory(dist), backups: backupHashes(c), modes: originalModes(c) });
        atomic(path, bytes); atomic(anchor, `${hash(bytes)}\n`);
    }
    if (!existsSync(anchor) || lstatSync(anchor).size > 128 || lstatSync(path).size > 1024 * 1024 || regularBytes(anchor, "utf8").trim() !== hash(regularBytes(path))) throw Error("baseline_anchor_drift");
    const baseline = read(path);
    if (typeof baseline.dist !== "string" || !baseline.dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !baseline.dist.endsWith("/dist") || realpathSync(baseline.dist) !== baseline.dist) throw Error("baseline_path_drift");
    if (JSON.stringify(inventory(baseline.dist)) !== JSON.stringify(baseline.files)) throw Error("baseline_build_drift");
    const backups = backupHashes(c);
    if (JSON.stringify(baseline.backups) !== JSON.stringify(backups)) throw Error("backup_drift");
    if (JSON.stringify(baseline.modes) !== JSON.stringify(originalModes(c))) throw Error("original_modes_drift");
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
    if (existsSync(native)) for (const name of ["helper.log", "lease.json", "history.json", "diagnostics.json", "installation.json"]) writableTarget(join(native, name), true);
    if (existsSync(root)) writableTarget(join(root, "display.json"), true);
    const configPath = join(native, "installation.json");
    if (existsSync(configPath) && (lstatSync(configPath).isSymbolicLink() || read(configPath).snapshot !== join(root, "display.json") || read(configPath).version !== 1)) throw Error("helper_configuration_drift");
    const helperPath = join(root, "display-helper.mjs"), receipt = join(c.ledger, "installed.json");
    const helperStat = statOrNull(helperPath), hasReceipt = existsSync(receipt);
    if (hasReceipt && !existsSync(configPath)) throw Error("installed_helper_configuration_missing");
    if (!hasReceipt && statOrNull(configPath)) throw Error("unowned_helper_configuration");
    if (!hasReceipt) for (const path of ["helper.log", "lease.json", "history.json", "diagnostics.json"].map(name => join(native, name)).concat(join(root, "display.json"))) {
        if (statOrNull(path)) throw Error("unowned_runtime_artifact");
    }
    if (Boolean(helperStat) !== hasReceipt || (helperStat && (!helperStat.isFile() || helperStat.isSymbolicLink() || hash(regularBytes(helperPath)) !== read(receipt).helperHash))) throw Error("installed_helper_drift");
    const launcher = regularBytes(c.mainLauncher, "utf8");
    const marker = "# PresenceGuard process-bound observer";
    const installed = join(c.ledger, "installed-launcher.sha256");
    if (launcher.includes(marker)) {
        if (!existsSync(installed) || regularBytes(installed, "utf8").trim() !== hash(launcher)) throw Error("launcher_drift");
        return { root, native, configPath, launcher };
    }
    const lines = launcher.trimEnd().split("\n");
    if (!lines.at(-1).startsWith("exec ") || !lines.at(-1).includes("mullvad-exclude") || !lines.at(-1).includes("flatpak run")) throw Error("unsupported_launcher_shape_preserved");
    const launch = lines.pop();
    const injection = `${marker}\npg_start=$(awk ${shellQuote(PARENT_START_AWK)} /proc/$$/stat)\n/usr/bin/gjs -m ${shellQuote(join(root, "display-helper.mjs"))} "$$" "$pg_start" ${shellQuote(join(root, "display.json"))} ${shellQuote(join(native, "lease.json"))} >> ${shellQuote(join(native, "helper.log"))} 2>&1 &\n`;
    const next = `${lines.join("\n")}\n${injection}${launch}\n`;
    return { root, native, configPath, launcher: next };
}
export function candidateDist(c, commit) {
    if (typeof c.updaterPending !== "string" || !isAbsolute(c.updaterPending)) throw Error("updaterPending_required_for_installation");
    let dist;
    if (statOrNull(c.updaterPending)) dist = join(read(c.updaterPending).release, "dist");
    else {
        const receipt = statOrNull(join(c.ledger, "installed.json")) && read(join(c.ledger, "installed.json"));
        if (!receipt || receipt.commit !== commit || realpathSync(join(c.vencordRoot, "dist")) !== receipt.dist) throw Error("validated_pending_candidate_required");
        dist = receipt.dist;
    }
    const root = realpathSync(join(c.vencordRoot, ".wout-releases"));
    if (dirname(dirname(dist)) !== root || realpathSync(dist) !== dist) throw Error("candidate_not_retained_release");
    const manifest = read(join(dirname(dist), "manifest.json")), actual = inventory(dist);
    if (!manifest.bundle_hashes || Object.keys(actual).length !== Object.keys(manifest.bundle_hashes).length || Object.entries(actual).some(([key, value]) => manifest.bundle_hashes[key] !== value)) throw Error("candidate_bundle_hash_mismatch");
    for (const file of ["vencordDesktopMain.js", "vencordDesktopRenderer.js"]) {
        const text = regularBytes(join(dist, file), "utf8");
        if (!text.includes("PresenceGuard") || (file.includes("Renderer") && !text.includes(commit))) throw Error("candidate_build_identity_mismatch");
    }
    return dist;
}
export async function main(args) {
    const action = args[0], path = args[args.indexOf("--config") + 1];
    if (!args.includes("--config") || !path) throw Error("use --config with an owner-only installation descriptor");
    const c = descriptor(resolve(path)), dry = args.includes("--dry-run");
    const locked = args.includes("--locked");
    if (locked && !holdsUpdaterLock(c.updaterLock)) throw Error("updater_lock_not_held");
    const underLock = (childArgs = args) => { mkdirSync(dirname(c.updaterLock), { recursive: true, mode: 0o700 }); return execFileSync("/usr/bin/flock", ["--no-fork", "-n", c.updaterLock, process.execPath, fileURLToPath(import.meta.url), ...childArgs, "--locked"], { stdio: "inherit" }); };
    if (action === "inspect") return console.log(JSON.stringify(inspect(c), null, 2));
    if (["stage", "prepare"].includes(action) && pendingIntegration(c)) throw Error("integration_recovery_required_use_install_or_rollback");
    if (action === "stage") { if (!dry && !locked) return underLock(); return console.log(JSON.stringify(lockedStage(project, c.vencordRoot, dry), null, 2)); }
    if (action === "prepare") {
        if (!dry && !locked) return underLock();
        verifyWiring(c); // Authenticate the executable and mode before staging or running it.
        if (dry) return console.log(JSON.stringify(lockedStage(project, c.vencordRoot, true)));
        console.log(JSON.stringify(lockedStage(project, c.vencordRoot)));
        runUpdater(c, "rebuild"); return;
    }
    if (!["install", "update", "rollback", "uninstall"].includes(action)) throw Error("unknown_install_action");
    if (dry) {
        const recovery = pendingIntegration(c);
        if (recovery) return console.log(JSON.stringify({ action, recovery: { kind: recovery.kind, commit: recovery.commit }, message: "Repeat the interrupted action while both profiles are closed; rollback can cancel an unactivated install." }));
        if (action === "install" || action === "update") { verifyWiring(c); planSettings(c); planHelper(c); candidateDist(c, verifyCandidate(c).commit); }
        return console.log(JSON.stringify({ action, ...inspect(c), changes: ["main plugin settings", "main helper launcher", "retained build activation"], restarts: "Both profiles must be gracefully closed by the operator; no implicit termination." }, null, 2));
    }
    if (processes().length) throw Error("vesktop_running_close_identified_profiles_gracefully_after_call_capture_preflight");
    if (!locked) return underLock();
    const pending = pendingIntegration(c);
    if (pending) {
        const undo = action === "rollback" || action === "uninstall";
        const result = finishIntegration(c, pending, expected => {
            if (candidateDist(c, pending.commit) !== expected) throw Error("recovery_candidate_changed");
            runUpdater(c, "activate");
        }, undo);
        if (!undo && pending.kind === "rollback") throw Error("rollback_recovered_reapply_updater_before_installation");
        if (!undo && pending.commit !== execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()) throw Error("recovered_older_installation_prepare_current_head");
        if (!undo || pending.kind === "rollback" || (result.cancelled && !existsSync(join(c.ledger, "installed.json")))) return console.log(JSON.stringify({ recovered: result, message: "Prepared transaction recovered; review the recorded commit before a newer update." }));
    }
    if (action === "install" || action === "update") {
        const manifest = verifyCandidate(c);
        // The maintained updater inherits the held lock and retains candidate/activation checks.
        const wiring = verifyWiring(c);
        const rolledBack = rollbackRecord(c);
        if (rolledBack && realpathSync(join(c.vencordRoot, "dist")) !== rolledBack.dist) throw Error("rollback_build_drift");
        const settings = planSettings(c);
        const plan = planHelper(c);
        const helper = compileHelper(project, manifest.commit);
        pinBaseline(c);
        const active = candidateDist(c, manifest.commit);
        const receipt = { commit: manifest.commit, helperHash: hash(helper), installedAt: new Date().toISOString(), dist: active, rendererHash: hash(regularBytes(join(active, "vencordDesktopRenderer.js"))), mainHash: hash(regularBytes(join(active, "vencordDesktopMain.js"))) };
        const changes = [
            { key: "helper", data: helper },
            { key: "launcher", data: plan.launcher, mode: wiring.launcherMode },
            { key: "launcherReceipt", data: `${hash(plan.launcher)}\n` },
            { key: "settings", data: JSON.stringify(settings) }
        ];
        if (!existsSync(plan.configPath) || rolledBack) changes.push({ key: "helperConfig", data: JSON.stringify({ version: 1, snapshot: join(plan.root, "display.json"), welcome: true }) });
        if (rolledBack) changes.push({ key: "rolledBack", data: null });
        changes.push({ key: "installed", data: JSON.stringify(receipt, null, 2) });
        const tx = prepareIntegration(c, "install", manifest.commit, active, changes);
        finishIntegration(c, tx, expected => {
            if (candidateDist(c, manifest.commit) !== expected) throw Error("activation_candidate_changed");
            runUpdater(c, "activate");
        });
        console.log(JSON.stringify(receipt, null, 2)); return;
    }
    // Restore the pinned, hash-verified retained release, independent of later update history.
    const rolledBack = join(c.ledger, "rolled-back.json");
    if (!existsSync(join(c.ledger, "installed.json"))) throw Error("no_installation_receipt");
    const currentSettings = preflightRollback(c);
    const baseline = pinBaseline(c);
    if (existsSync(rolledBack)) {
        if (realpathSync(join(c.vencordRoot, "dist")) !== baseline.dist || hash(regularBytes(c.mainLauncher)) !== hash(regularBytes(join(c.ledger, "backups/main-launcher"))) || hash(regularBytes(c.updater)) !== hash(regularBytes(join(c.ledger, "backups/updater"))) || (lstatSync(c.mainLauncher).mode & 0o777) !== baseline.modes["main-launcher"] || (lstatSync(c.updater).mode & 0o777) !== baseline.modes.updater) throw Error("rollback_drift");
        return console.log("Previous integration is already restored; history retained.");
    }
    verifyWiring(c);
    const settings = restoreMain(currentSettings, read(join(c.ledger, "backups/main-plugins")));
    const current = realpathSync(join(c.vencordRoot, "dist"));
    const receipt = read(join(c.ledger, "installed.json"));
    if (current !== receipt.dist || hash(regularBytes(join(current, "vencordDesktopRenderer.js"))) !== receipt.rendererHash || hash(regularBytes(join(current, "vencordDesktopMain.js"))) !== receipt.mainHash) throw Error("active_build_changed_since_installation");
    const tx = prepareIntegration(c, "rollback", receipt.commit, baseline.dist, [
        { key: "launcher", data: regularBytes(join(c.ledger, "backups/main-launcher")), mode: baseline.modes["main-launcher"] },
        { key: "settings", data: JSON.stringify(settings) },
        { key: "lease", data: JSON.stringify({ enabled: false, at: Date.now() }) },
        { key: "updater", data: regularBytes(join(c.ledger, "backups/updater")), mode: baseline.modes.updater },
        { key: "rolledBack", data: JSON.stringify({ at: new Date().toISOString(), dist: baseline.dist }) }
    ]);
    finishIntegration(c, tx, () => { throw Error("rollback_does_not_execute_updater"); });
    console.log("Previous integration restored; local history and unrelated settings retained. Relaunch the previous profiles normally.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
