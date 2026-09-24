// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isConfiguredIntervention, isManualSelectionUpdate, matchesManualExpiry, matchesManualSelectionExpiry, type ConfiguredUpdateEvidence } from "../src/core/configured-update";

const evidence = (extra: Partial<ConfiguredUpdateEvidence> = {}): ConfiguredUpdateEvidence => ({
    hasConfiguredStatus: true, changed: true, local: false, partial: true,
    pluginLocalUpdate: false, correlatedPluginSave: false, matchedManualSelection: false,
    ...extra
});

test("observable external configured value and duration changes revoke control", () => {
    assert.equal(isConfiguredIntervention(evidence()), true);
    assert.equal(isConfiguredIntervention(evidence({ changed: true, wasSaved: true, partial: false })), true);
    assert.equal(isConfiguredIntervention(evidence({ local: undefined, partial: true })), true);
});
test("same-value edits require an actual configured signature change", () => {
    assert.equal(isConfiguredIntervention(evidence({ changed: false, wasSaved: true })), false);
});
test("own local update and exact correlated save echo are not external interventions", () => {
    assert.equal(isConfiguredIntervention(evidence({ local: true, pluginLocalUpdate: true })), false);
    assert.equal(isConfiguredIntervention(evidence({ correlatedPluginSave: true, wasSaved: true })), false);
});
test("a manual same-value or duration selection is handled by the synchronous picker hook", () => {
    assert.equal(isConfiguredIntervention(evidence({ local: false, wasSaved: true, matchedManualSelection: true })), false);
});
test("picker acknowledgement requires the changed local target and its selected duration", () => {
    const expected = { expected: true, changed: true, local: true, partial: true, targetMatches: true, expiryMatches: true };
    assert.equal(isManualSelectionUpdate(expected), true);
    assert.equal(isManualSelectionUpdate({ ...expected, local: false }), false);
    assert.equal(isManualSelectionUpdate({ ...expected, local: undefined }), false);
    assert.equal(isManualSelectionUpdate({ ...expected, partial: false }), false);
    assert.equal(isManualSelectionUpdate({ ...expected, changed: false }), false);
    assert.equal(isManualSelectionUpdate({ ...expected, targetMatches: false }), false);
    assert.equal(isManualSelectionUpdate({ ...expected, expiryMatches: false }), false);
});
test("picker expiry correlation accepts the immediate local write and rejects another duration", () => {
    assert.equal(matchesManualExpiry(0, "0"), true);
    assert.equal(matchesManualExpiry(3_600_000, 3_601_000), true);
    assert.equal(matchesManualExpiry(3_600_000, 1_800_000), false);
    assert.equal(matchesManualExpiry(0, undefined), false);
});
test("status-only picker updates match only selections without a duration", () => {
    assert.equal(matchesManualSelectionExpiry(0, false, undefined), true);
    assert.equal(matchesManualSelectionExpiry(0, true, null), true);
    assert.equal(matchesManualSelectionExpiry(0, true, "0"), true);
    assert.equal(matchesManualSelectionExpiry(0, true, "1200"), false);
    assert.equal(matchesManualSelectionExpiry(3_600_000, false, undefined), false);
    assert.equal(matchesManualSelectionExpiry(3_600_000, true, null), false);
    assert.equal(matchesManualSelectionExpiry(3_600_000, true, 3_600_500), true);
});
test("ordinary full snapshots, aggregate presence and session events do not prove a manual selection", () => {
    assert.equal(isConfiguredIntervention(evidence({ local: false, partial: false, wasSaved: false })), false);
    assert.equal(isConfiguredIntervention(evidence({ hasConfiguredStatus: false, changed: true })), false);
});
test("wasSaved by itself is not a synchronization or intervention proof", () => {
    assert.equal(isConfiguredIntervention(evidence({ changed: false, wasSaved: true })), false);
});
