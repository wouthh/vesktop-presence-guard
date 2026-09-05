// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GLibUnix from "gi://GLibUnix";
import { leaseActive, releaseMonitoring, startIdentity } from "./lifetime";
// Fixed installation paths are provided by an owner-only launcher, never the renderer.
const [parentText, parentStart, snapshotPath, leasePath] = ARGV;
if (!/^\d+$/.test(parentText ?? "") || !/^\d+$/.test(parentStart ?? "") || !snapshotPath?.startsWith("/") || !leasePath?.startsWith("/")) throw Error("invalid_helper_arguments");
const loop = new GLib.MainLoop(null, false);
const decoder = new TextDecoder();
function read(path: string) {
    const info = Gio.File.new_for_path(path).query_info("standard::type,standard::size", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 65536) throw Error("unsafe_helper_input");
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok || bytes.length > 65536) throw Error("bounded_read_failed");
    return decoder.decode(bytes);
}
function identity() {
    try { const s = read(`/proc/${parentText}/stat`); return startIdentity(s) === parentStart; } catch { return false; }
}
function write(value: unknown) {
    const file = Gio.File.new_for_path(snapshotPath);
    file.replace_contents(new TextEncoder().encode(JSON.stringify(value)), null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
function call(bus: any, name: string, path: string, iface: string, method: string, params: any = null): Promise<any> {
    return new Promise((resolve, reject) => bus.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, 1500, null, (_: unknown, result: unknown) => {
        try { resolve(bus.call_finish(result).deepUnpack()); } catch { reject(Error("dbus_unavailable")); }
    }));
}
const session = Gio.DBus.session;
const system = Gio.DBus.system;
const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.session" });
const instance = GLib.uuid_string_random();
let provider = 0;
let lastLease = false;
let busy = false;
let lastStart = 0;
const ids: { bus: any; id: number }[] = [];
function subscribe(bus: any, name: string, iface: string, signal: string, path: string | null, fn: (...args: any[]) => void) {
    ids.push({ bus, id: bus.signal_subscribe(name, iface, signal, path, null, Gio.DBusSignalFlags.NONE, fn) });
}
async function observe() {
    if (busy) return;
    if (!identity()) { cleanup(); loop.quit(); return; }
    let enabled = false;
    try { enabled = leaseActive(JSON.parse(read(leasePath)), Date.now()); } catch { /* Missing lease stops collection. */ }
    if (!enabled) {
        const wasEnabled = lastLease;
        lastLease = false;
        releaseMonitoring(() => { if (wasEnabled) write({ version: 1, at: Date.now(), observation: null, reason: "lease_inactive" }); }, unsubscribe);
        return;
    }
    if (!lastLease) { provider++; startSubscriptions(); }
    lastLease = true;
    busy = true;
    const at = Date.now();
    if (lastStart && at - lastStart > 10000) provider++;
    lastStart = at;
    try {
        const [power, idle, locked, topology, owner, sleep] = await Promise.all([
            call(session, "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.freedesktop.DBus.Properties", "Get", new GLib.Variant("(ss)", ["org.gnome.Mutter.DisplayConfig", "PowerSaveMode"])),
            call(session, "org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime"),
            call(session, "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "GetActive"),
            call(session, "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", "GetCurrentState"),
            call(session, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", new GLib.Variant("(s)", ["org.gnome.Mutter.DisplayConfig"])),
            call(system, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.DBus.Properties", "Get", new GLib.Variant("(ss)", ["org.freedesktop.login1.Manager", "PreparingForSleep"]))
        ]);
        const logical = topology[2];
        if (!Array.isArray(logical)) throw Error();
        // Do not persist monitor names/serials. Geometry and connector count suffice for continuity.
        const shape = logical.map((m: any[]) => [m[0], m[1], m[2], m[3], m[5]?.length]);
        const observation = { at, power: power[0].deepUnpack(), idleMs: Number(idle[0]), thresholdMs: settings.get_uint("idle-delay") * 1000, locked: locked[0], suspended: sleep[0].deepUnpack(), topology: JSON.stringify(shape), monitors: logical.length, provider: `${owner[0]}:${instance}:${provider}` };
        if (lastLease && identity()) write({ version: 1, at, observation });
    } catch { provider++; write({ version: 1, at, observation: null, reason: "gnome_provider_unavailable" }); }
    finally { busy = false; }
}
function startSubscriptions() {
subscribe(system, "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep", "/org/freedesktop/login1", () => { provider++; void observe(); });
subscribe(session, "org.gnome.Mutter.DisplayConfig", "org.freedesktop.DBus.Properties", "PropertiesChanged", "/org/gnome/Mutter/DisplayConfig", () => { void observe(); });
subscribe(session, "org.gnome.Mutter.DisplayConfig", "org.gnome.Mutter.DisplayConfig", "MonitorsChanged", "/org/gnome/Mutter/DisplayConfig", () => { provider++; void observe(); });
subscribe(session, "org.gnome.ScreenSaver", "org.gnome.ScreenSaver", "ActiveChanged", "/org/gnome/ScreenSaver", () => { void observe(); });
}
function unsubscribe() {
    for (const { bus, id } of ids.splice(0)) bus.signal_unsubscribe(id);
}
const interval = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { void observe(); return GLib.SOURCE_CONTINUE; });
function cleanup() {
    unsubscribe();
    GLib.source_remove(interval);
    try { write({ version: 1, at: Date.now(), observation: null, reason: "helper_stopped" }); } catch { /* Parent may have removed installation. */ }
}
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => { cleanup(); loop.quit(); return GLib.SOURCE_REMOVE; });
// Start only after entering the main loop so an already-exited parent can quit it.
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { void observe(); return GLib.SOURCE_REMOVE; });
loop.run();
