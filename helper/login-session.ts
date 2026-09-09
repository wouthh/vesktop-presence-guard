// SPDX-License-Identifier: GPL-3.0-or-later
// Accept only the current user's active graphical session, never a greeter or
// an unrelated login session selected by logind's automatic lookup.
export function loginSession(value: Record<string, unknown>, uid: number): { locked: boolean; identity: string } {
    if (!Array.isArray(value.User) || value.User[0] !== uid || value.Active !== true || value.Type !== "wayland" || value.Class !== "user" || typeof value.LockedHint !== "boolean" || typeof value.Id !== "string" || !value.Id || value.Id.length > 128) throw Error("active_own_wayland_session_unavailable");
    return { locked: value.LockedHint, identity: value.Id };
}
