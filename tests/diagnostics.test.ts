/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ownershipTransitionDiagnostic } from "../src/core/diagnostics";

test("allowlisted ownership transition timestamp uses the renderer's stable key", () => {
    assert.deepEqual(ownershipTransitionDiagnostic(123), { ownershipTransitionAt: 123 });
    assert.deepEqual(ownershipTransitionDiagnostic("123"), {});
    assert.deepEqual(ownershipTransitionDiagnostic(Number.NaN), {});
});
