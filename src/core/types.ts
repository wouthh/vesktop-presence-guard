/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPDX-License-Identifier: GPL-3.0-or-later
export type Status = "online" | "idle" | "dnd" | "invisible" | "offline" | "unknown";
export type Rule = "idle" | "camera";
export type SignalValue = "active" | "inactive" | "unknown";
export interface DisplayFacts {
    power: number;
    locked: boolean;
    shieldActive: boolean;
    suspended: boolean;
    idleThresholdReached: boolean;
    thresholdMs: number;
    monitors: number;
}
export interface Signal {
    value: SignalValue;
    at: number;
    reason: string;
    scope: string;
    facts?: DisplayFacts; // Observations only; never authorize a status write.
}
export interface Snapshot {
    account: string | null; // Process-local only; never copied into history.
    connected: boolean;
    capable: boolean;
    configured: Status;
    effective: Status;
    aggregate: Status;
    nativeIdle: boolean | null;
    display: Signal; // active = confirmed active session, inactive = qualifying blanking
    camera: Signal; // active = confirmed capture, inactive = cleared within stated scope
}
export interface Options { observe: boolean; idle: boolean; camera: boolean; }
export type EventKind = "observation" | "request" | "confirmation" | "skip" | "simulation" | "error" | "boundary";
export type Source = "manual" | "plugin" | "native/client" | "external" | "unknown";
export interface HistoryEvent {
    at: number;
    kind: EventKind;
    source: Source;
    previous: Status;
    status: Status;
    configured: Status;
    aggregate: Status;
    reason: string;
    owned: boolean;
    display: Signal;
    camera: Signal;
}
export interface Clock {
    now(): number;
    set(callback: () => void, delay: number): unknown;
    clear(handle: unknown): void;
}
export interface WriteToken { generation: number; target: Status; rule: Rule; }
export interface Adapter {
    read(): Snapshot;
    write(token: WriteToken, guard: () => boolean): Promise<void>;
    record(event: HistoryEvent): void;
}
export const UNKNOWN = (scope: string, reason = "unavailable", at = 0): Signal => ({ value: "unknown", scope, reason, at });
export function status(value: unknown): Status {
    return ["online", "idle", "dnd", "invisible", "offline"].includes(value as string) ? value as Status : "unknown";
}
export function fresh(signal: Signal, now: number): boolean {
    return Number.isFinite(signal.at) && now >= signal.at && now - signal.at <= 10_000 && signal.value !== "unknown";
}
