// SPDX-License-Identifier: GPL-3.0-or-later
export function startIdentity(stat: string): string | undefined {
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
export function leaseActive(value: unknown, now: number): boolean {
    if (!value || typeof value !== "object") return false;
    const lease = value as { enabled: unknown; at: number };
    return lease.enabled === true && Number.isFinite(lease.at) && now >= lease.at && now - lease.at < 10000;
}
