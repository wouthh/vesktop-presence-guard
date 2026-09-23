// SPDX-License-Identifier: GPL-3.0-or-later
/** Do not publish activity sampled before a provider/session continuity boundary. */
export function activityForCurrentEpoch<T>(activity: T | null, sampledEpoch: number | null, currentEpoch: number): T | null {
    return activity !== null && sampledEpoch !== null && sampledEpoch === currentEpoch ? activity : null;
}
