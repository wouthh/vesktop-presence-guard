// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hash, inventory, stage, verifyStaged } from "./staging.mjs";
import { regularBytes, descriptorBytes } from "./regular-file.mjs";
import { exclusiveLockDescriptor as updaterLockDescriptor, holdsExclusiveLock as holdsUpdaterLock } from "./locks.mjs";
import { lockedStage, stageLock } from "./locked-stage.mjs";
import { finishIntegration, pendingIntegration, prepareIntegration, snapshotIntegrationTargets } from "./integration-transaction.mjs";
import { pendingSnapshot } from "./pending-snapshot.mjs";
import { compileHelper } from "./helper-build.mjs";
import { publishBaseline } from "./baseline-publication.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(regularBytes(path, "utf8"));
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
    for (const key of ["vencordRoot", "mainProfile", "altProfile", "updater", "updaterLock", "ledger"]) if (typeof c[key] !== "string" || !isAbsolute(c[key])) throw Error(`invalid_${key}`);
    if (realpathSync(c.mainProfile) === realpathSync(c.altProfile)) throw Error("profiles_must_be_distinct");
    const state = read(join(c.mainProfile, "state.json"));
    if (state.vencordDir !== join(c.vencordRoot, "dist")) throw Error("main_profile_not_using_managed_dist");
    return c;
}
// Read-only: the host launcher owns starting the observer; report when it does not.
const launcherStartsObserver = c => { try { return typeof c.mainLauncher === "string" ? regularBytes(c.mainLauncher, "utf8").includes("# PresenceGuard process-bound observer") : null; } catch { return null; } };
export function inspect(c) {
    const settings = read(join(c.mainProfile, "settings/settings.json"));
    const marker = join(c.vencordRoot, "src/userplugins/presenceGuard/.presence-guard-stage.json");
    const pending = pendingIntegration(c);
    return { launcherStartsObserver: launcherStartsObserver(c), baselineRecovery: Boolean(statOrNull(join(c.ledger, "baseline.sha256.publication"))), integrationRecovery: pending ? { kind: pending.kind, commit: pending.commit } : null, running: processes(), activeBuild: realpathSync(join(c.vencordRoot, "dist")), plugin: settings.plugins?.PresenceGuard ?? null, stagedCommit: existsSync(marker) ? read(marker).commit : null, existingSources: readdirSync(join(c.vencordRoot, "src/userplugins")).sort() };
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
export function verifyWiring(c, recoverPublication = true) {
    rollbackRecord(c, recoverPublication);
    if (statOrNull(join(c.vencordRoot, ".presence-guard/baseline.json")) || statOrNull(join(c.ledger, "baseline.sha256.publication"))) pinBaseline(c, recoverPublication);
    else backupHashes(c);
}
export { exclusiveLockDescriptor as updaterLockDescriptor, holdsExclusiveLock as holdsUpdaterLock } from "./locks.mjs";
export function runUpdater(c, action, execute = execFileSync, expectedDist) {
    if (!["rebuild", "activate"].includes(action)) throw Error("unsupported_updater_action");
    const lock = updaterLockDescriptor(c.updaterLock);
    if (lock === undefined) throw Error("updater_lock_not_held");
    verifyWiring(c);
    const fd = openSync(c.updater, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let snapshot;
    try {
        // Linux preserves these inherited descriptors through the script's shebang.
        // The reviewed updater validates FD 4 against its lock before accepting it.
        const stdio = ["inherit", "inherit", "inherit", fd, Number(lock)];
        const env = { ...process.env, PRESENCE_GUARD_LOCK_FD: "4" };
        for (const key of ["PRESENCE_GUARD_PENDING_FD", "PRESENCE_GUARD_PENDING_SHA256", "PRESENCE_GUARD_PENDING_PATH", "PRESENCE_GUARD_EXPECTED_RELEASE"]) delete env[key];
        if (action === "activate") {
            if (!descriptorBytes(fd, "utf8").includes("# PresenceGuard bound pending v1")) throw Error("updater_pending_handoff_unsupported");
            snapshot = pendingSnapshot(c, expectedDist);
            stdio.push(snapshot.fd);
            Object.assign(env, { PRESENCE_GUARD_PENDING_FD: "5", PRESENCE_GUARD_PENDING_SHA256: snapshot.hash, PRESENCE_GUARD_PENDING_PATH: c.updaterPending, PRESENCE_GUARD_EXPECTED_RELEASE: dirname(expectedDist) });
        }
        return execute("/proc/self/fd/3", [action], { stdio, env });
    } finally { snapshot?.close(); closeSync(fd); }
}
function backupHashes(c) {
    const result = {};
    for (const name of ["main-plugins"]) {
        const path = join(c.ledger, "backups", name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error("unsafe_backup");
        if (name === "main-plugins" && (!read(path)?.plugins || typeof read(path).plugins !== "object" || Array.isArray(read(path).plugins))) throw Error("malformed_backup_settings");
        result[name] = hash(regularBytes(path));
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
export function planSettings(c) { return enableMain(readSettings(c), Boolean(c.ledger && existsSync(join(c.ledger, "installed.json")) && !existsSync(join(c.ledger, "rolled-back.json")))); }
export function rollbackRecord(c, recoverPublication = true) {
    const path = join(c.ledger, "rolled-back.json");
    if (!statOrNull(path)) return null;
    writableTarget(path);
    const record = read(path);
    if (record?.dist !== pinBaseline(c, recoverPublication).dist || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) throw Error("rollback_receipt_drift");
    return record;
}
export function preflightRollback(c) {
    for (const path of [join(c.mainProfile, "PresenceGuard/lease.json"), join(c.ledger, "rolled-back.json")]) writableTarget(path, true);
    const root = lstatSync(c.vencordRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error("unsafe_vencord_root");
    accessSync(c.vencordRoot, constants.W_OK);
    return readSettings(c);
}
export function verifyCompletedRollback(c, currentSettings, baseline) {
    const record = rollbackRecord(c);
    if (!record || record.dist !== baseline.dist) throw Error("rollback_receipt_drift");
    const before = read(join(c.ledger, "backups/main-plugins"));
    if (Object.hasOwn(currentSettings.plugins, "PresenceGuard") !== Object.hasOwn(before.plugins, "PresenceGuard") || !isDeepStrictEqual(currentSettings.plugins.PresenceGuard, before.plugins.PresenceGuard)) throw Error("rollback_settings_drift");
    const lease = read(join(c.mainProfile, "PresenceGuard/lease.json"));
    if (lease?.enabled !== false || !Number.isFinite(lease.at)) throw Error("rollback_lease_drift");
}
export function pinBaseline(c, recoverPublication = true) {
    const root = join(c.vencordRoot, ".presence-guard"), path = join(root, "baseline.json");
    const anchor = join(c.ledger, "baseline.sha256");
    writableTarget(anchor, true);
    if (!existsSync(path) && existsSync(join(c.ledger, "installed.json"))) throw Error("installed_baseline_missing");
    if (!recoverPublication && statOrNull(`${anchor}.publication`)) throw Error("baseline_publication_recovery_required");
    if (recoverPublication) mkdirSync(root, { recursive: true, mode: 0o700 });
    writableTarget(path, true);
    const initial = () => {
        const dist = realpathSync(join(c.vencordRoot, "dist"));
        if (!dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !dist.endsWith("/dist")) throw Error("baseline_not_retained_release");
        return { dist, files: inventory(dist), backups: backupHashes(c) };
    };
    const validateInitial = candidate => {
        if (existsSync(join(c.ledger, "installed.json")) || JSON.stringify(candidate) !== JSON.stringify(initial())) throw Error("initial_baseline_state_changed");
    };
    if (statOrNull(`${anchor}.publication`)) {
        if (!recoverPublication) throw Error("baseline_publication_recovery_required");
        publishBaseline(path, anchor, undefined, validateInitial);
    }
    if (!existsSync(path)) {
        if (!recoverPublication) throw Error("baseline_initialization_required");
        if (existsSync(anchor)) throw Error("baseline_manifest_missing");
        publishBaseline(path, anchor, JSON.stringify(initial()), validateInitial);
    }
    if (!existsSync(anchor) || lstatSync(anchor).size > 128 || lstatSync(path).size > 1024 * 1024 || regularBytes(anchor, "utf8").trim() !== hash(regularBytes(path))) throw Error("baseline_anchor_drift");
    const baseline = read(path);
    if (typeof baseline.dist !== "string" || !baseline.dist.startsWith(`${realpathSync(join(c.vencordRoot, ".wout-releases"))}/`) || !baseline.dist.endsWith("/dist") || realpathSync(baseline.dist) !== baseline.dist) throw Error("baseline_path_drift");
    if (JSON.stringify(inventory(baseline.dist)) !== JSON.stringify(baseline.files)) throw Error("baseline_build_drift");
    const backups = backupHashes(c);
    if (baseline.backups?.["main-plugins"] !== backups["main-plugins"]) throw Error("backup_drift");
    return baseline;
}
export function planHelper(c) {
    const root = join(c.vencordRoot, ".presence-guard"), native = join(c.mainProfile, "PresenceGuard");
    for (const path of [root, native]) {
        const stat = statOrNull(path);
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error("helper_directory_drift");
        accessSync(stat ? path : dirname(path), constants.W_OK);
    }
    writableTarget(join(c.ledger, "installed.json"), true);
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
    return { root, native, configPath };
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
    const underLock = (childArgs = args) => {
        mkdirSync(dirname(c.updaterLock), { recursive: true, mode: 0o700 });
        const command = [process.execPath, fileURLToPath(import.meta.url), ...childArgs, "--locked"];
        // Both no-fork wrappers become the same Node process, retaining both locks
        // through staging and the synchronous maintained-updater rebuild.
        if (action === "prepare") command.unshift("/usr/bin/flock", "--no-fork", "-n", stageLock(c.vencordRoot));
        return execFileSync("/usr/bin/flock", ["--no-fork", "-n", c.updaterLock, ...command], { stdio: "inherit" });
    };
    if (action === "inspect") return console.log(JSON.stringify(inspect(c), null, 2));
    if (["stage", "prepare"].includes(action) && pendingIntegration(c)) throw Error("integration_recovery_required_use_install_or_rollback");
    if (action === "stage") { if (!dry && !locked) return underLock(); return console.log(JSON.stringify(lockedStage(project, c.vencordRoot, dry), null, 2)); }
    if (action === "prepare") {
        if (!dry && !locked) return underLock();
        verifyWiring(c, !dry); // Authenticate the executable and mode before staging or running it.
        if (dry) return console.log(JSON.stringify(lockedStage(project, c.vencordRoot, true)));
        if (!holdsUpdaterLock(stageLock(c.vencordRoot))) throw Error("preparation_stage_lock_not_held");
        console.log(JSON.stringify(stage(project, c.vencordRoot)));
        runUpdater(c, "rebuild"); return;
    }
    if (!["install", "update", "rollback", "uninstall"].includes(action)) throw Error("unknown_install_action");
    if (dry) {
        const recovery = pendingIntegration(c);
        if (recovery) return console.log(JSON.stringify({ action, recovery: { kind: recovery.kind, commit: recovery.commit }, message: "Repeat the interrupted action while both profiles are closed; rollback can cancel an unactivated install." }));
        if (action === "install" || action === "update") { verifyWiring(c, false); planSettings(c); planHelper(c); candidateDist(c, verifyCandidate(c).commit); }
        return console.log(JSON.stringify({ action, ...inspect(c), changes: ["main plugin settings", "main helper", "retained build activation"], restarts: "Both profiles must be gracefully closed by the operator; no implicit termination." }, null, 2));
    }
    if (processes().length) throw Error("vesktop_running_close_identified_profiles_gracefully_after_call_capture_preflight");
    if (!locked) return underLock();
    const pending = pendingIntegration(c);
    if (pending) {
        const undo = action === "rollback" || action === "uninstall";
        const result = finishIntegration(c, pending, expected => {
            if (candidateDist(c, pending.commit) !== expected) throw Error("recovery_candidate_changed");
            runUpdater(c, "activate", undefined, expected);
        }, undo);
        if (!undo && pending.kind === "rollback") throw Error("rollback_recovered_reapply_updater_before_installation");
        if (!undo && pending.commit !== execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()) throw Error("recovered_older_installation_prepare_current_head");
        if (!undo || pending.kind === "rollback" || (result.cancelled && !existsSync(join(c.ledger, "installed.json")))) return console.log(JSON.stringify({ recovered: result, message: "Prepared transaction recovered; review the recorded commit before a newer update." }));
    }
    if (action === "install" || action === "update") {
        const manifest = verifyCandidate(c);
        const preflight = snapshotIntegrationTargets(c);
        // The maintained updater inherits the held lock and retains candidate/activation checks.
        verifyWiring(c);
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
            { key: "settings", data: JSON.stringify(settings) }
        ];
        if (!existsSync(plan.configPath) || rolledBack) changes.push({ key: "helperConfig", data: JSON.stringify({ version: 1, snapshot: join(plan.root, "display.json"), welcome: true }) });
        if (rolledBack) changes.push({ key: "rolledBack", data: null });
        changes.push({ key: "installed", data: JSON.stringify(receipt, null, 2) });
        const tx = prepareIntegration(c, "install", manifest.commit, active, changes.map(change => ({ ...change, expectedBefore: preflight[change.key], expectedParents: preflight.parents })));
        finishIntegration(c, tx, expected => {
            if (candidateDist(c, manifest.commit) !== expected) throw Error("activation_candidate_changed");
            runUpdater(c, "activate", undefined, expected);
        });
        console.log(JSON.stringify(receipt, null, 2)); return;
    }
    // Restore the pinned, hash-verified retained release, independent of later update history.
    const rolledBack = join(c.ledger, "rolled-back.json");
    if (!existsSync(join(c.ledger, "installed.json"))) throw Error("no_installation_receipt");
    const preflight = snapshotIntegrationTargets(c);
    const currentSettings = preflightRollback(c);
    const baseline = pinBaseline(c);
    if (existsSync(rolledBack)) {
        verifyCompletedRollback(c, currentSettings, baseline);
        if (realpathSync(join(c.vencordRoot, "dist")) !== baseline.dist) throw Error("rollback_drift");
        return console.log("Previous integration is already restored; history retained.");
    }
    verifyWiring(c);
    const settings = restoreMain(currentSettings, read(join(c.ledger, "backups/main-plugins")));
    const current = realpathSync(join(c.vencordRoot, "dist"));
    const receipt = read(join(c.ledger, "installed.json"));
    if (current !== receipt.dist || hash(regularBytes(join(current, "vencordDesktopRenderer.js"))) !== receipt.rendererHash || hash(regularBytes(join(current, "vencordDesktopMain.js"))) !== receipt.mainHash) throw Error("active_build_changed_since_installation");
    const tx = prepareIntegration(c, "rollback", receipt.commit, baseline.dist, [
        { key: "settings", data: JSON.stringify(settings) },
        { key: "lease", data: JSON.stringify({ enabled: false, at: Date.now() }) },
        { key: "rolledBack", data: JSON.stringify({ at: new Date().toISOString(), dist: baseline.dist }) }
    ].map(change => ({ ...change, expectedBefore: preflight[change.key], expectedParents: preflight.parents })));
    finishIntegration(c, tx, () => { throw Error("rollback_does_not_execute_updater"); });
    console.log("Previous integration restored; local history and unrelated settings retained. Relaunch the previous profiles normally.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
