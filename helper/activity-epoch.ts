// SPDX-License-Identifier: GPL-3.0-or-later
/** Do not publish activity sampled before a provider/session continuity boundary. */
export function activityForCurrentEpoch<T>(activity: T | null, sampledEpoch: number | null, currentEpoch: number, sessionValidated = true): T | null {
    return sessionValidated && activity !== null && sampledEpoch !== null && sampledEpoch === currentEpoch ? activity : null;
}

export function watchRegistrationIsCurrent(requestOwner: string, requestEpoch: number, currentOwner: string, currentEpoch: number) {
    return requestOwner !== "" && requestOwner === currentOwner && requestEpoch === currentEpoch;
}
