// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isConfiguredIntervention, type ConfiguredUpdateEvidence } from "../src/core/configured-update";

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
test("ordinary full snapshots, aggregate presence and session events do not prove a manual selection", () => {
    assert.equal(isConfiguredIntervention(evidence({ local: false, partial: false, wasSaved: false })), false);
    assert.equal(isConfiguredIntervention(evidence({ hasConfiguredStatus: false, changed: true })), false);
});
test("wasSaved by itself is not a synchronization or intervention proof", () => {
    assert.equal(isConfiguredIntervention(evidence({ changed: false, wasSaved: true })), false);
});
