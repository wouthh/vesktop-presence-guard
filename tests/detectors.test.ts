// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { PipeWireDetector, combineCamera, cameraSnapshot } from "../src/core/camera";
import { DisplayDetector, type DisplayObservation } from "../src/core/display";
import { UNKNOWN } from "../src/core/types";
const display = (extra: Partial<DisplayObservation> = {}): DisplayObservation => ({ at: 1000, power: 0, idleMs: 0, thresholdMs: 300000, locked: false, suspended: false, topology: "synthetic-topology", monitors: 2, provider: "synthetic-provider", ...extra });
test("display needs correlated idle and power transition; confirms activity return", () => {
    const d = new DisplayDetector(); assert.equal(d.observe(display({ idleMs: 299000 })).value, "unknown"); assert.equal(d.observe(display({ at: 3000, idleMs: 301000, power: 3 })).value, "inactive"); assert.equal(d.observe(display({ at: 5000 })).value, "active");
});
test("blank on startup, manual lock and one disconnected display are not inactivity proof", () => {
    assert.equal(new DisplayDetector().observe(display({ power: 3, idleMs: 500000 })).value, "unknown");
    const d = new DisplayDetector(); d.observe(display()); d.observe(display({ at: 2000, locked: true, idleMs: 1000 })); assert.equal(d.observe(display({ at: 3000, locked: true, power: 3, idleMs: 2000 })).value, "unknown");
    const m = new DisplayDetector(); m.observe(display({ idleMs: 299000 })); assert.equal(m.observe(display({ at: 3000, idleMs: 301000, power: 3, topology: "one-display", monitors: 1 })).value, "unknown");
});
test("display provider restart, gap, suspend, malformed and unavailable are Unknown", () => {
    for (const sample of [display({ provider: "restarted", power: 3 }), display({ at: 30000, power: 3 }), display({ suspended: true }), display({ power: -1 }), display({ monitors: 0 }), null]) {
        const d = new DisplayDetector(); d.observe(display()); assert.equal(d.observe(sample).value, "unknown");
    }
});
const node = (id: number, state: string, props: object) => ({ id, type: "PipeWire:Interface:Node", info: { state, props } });
const core = { id: 0, type: "PipeWire:Interface:Core", info: { cookie: 123 } };
const camera = (state = "running") => node(10, state, { "media.class": "Video/Source", "device.api": "v4l2", "api.v4l2.cap.driver": "uvcvideo" });
const consumer = node(20, "running", { "media.class": "Stream/Input/Video" });
const link = { id: 30, type: "PipeWire:Interface:Link", info: { state: "active", "output-node-id": 10, "input-node-id": 20 } };
test("camera requires hardware provenance, running capture consumer and active link", () => {
    const d = new PipeWireDetector(); assert.equal(d.parse(JSON.stringify([core, camera(), consumer, link]), 1).value, "active"); assert.equal(d.parse(JSON.stringify([core, camera("suspended"), consumer]), 2).value, "inactive");
});
test("connected camera, playback, generic video and screen sharing are not positive capture", () => {
    for (const graph of [[camera("suspended")], [camera()], [node(10, "running", { "media.class": "Video/Source" }), consumer, link], [camera(), node(20, "running", { "media.class": "Stream/Output/Video" }), link]]) assert.notEqual(new PipeWireDetector().parse(JSON.stringify([core, ...graph]), 1).value, "active");
});
test("malformed graphs, disappeared captured camera and provider failures remain Unknown", () => {
    const d = new PipeWireDetector(); for (const s of ["{", "{}", "[null]", '[{"id":1}]']) assert.equal(d.parse(s, 1).value, "unknown"); d.parse(JSON.stringify([core, camera(), consumer, link]), 1); assert.equal(d.parse("[]", 2).value, "unknown");
});
test("positive evidence survives an unknown secondary provider; missing evidence never clears", () => {
    const active = { value: "active" as const, at: 100, scope: "fixture", reason: "capture" }; const clear = { ...active, value: "inactive" as const }; assert.equal(combineCamera(active, UNKNOWN("fixture"), 100).value, "active"); assert.equal(combineCamera(clear, UNKNOWN("fixture"), 100).value, "unknown"); assert.equal(combineCamera(clear, clear, 100).value, "inactive");
});

test("PipeWire restart cannot clear capture by reusing node IDs", () => {
    const d = new PipeWireDetector(); d.parse(JSON.stringify([core, camera(), consumer, link]), 1);
    const restarted = { ...core, info: { cookie: 456 } };
    assert.equal(d.parse(JSON.stringify([restarted, camera("suspended")]), 2).value, "unknown");
    assert.equal(d.parse(JSON.stringify([restarted, camera("suspended")]), 3).value, "unknown");
    assert.equal(d.parse(JSON.stringify([restarted, camera(), consumer, link]), 4).value, "active");
    assert.equal(d.parse(JSON.stringify([restarted, camera("suspended")]), 5).value, "inactive");
});
test("missing display lock/suspend fields cannot prove return", () => {
    const sample = display(); delete (sample as Partial<DisplayObservation>).locked;
    assert.equal(new DisplayDetector().observe(sample).value, "unknown");
});

test("hot re-enable blocks fresh PipeWire acquisition when local camera continuity was lost", () => {
    const active = { value: "active" as const, at: 100, scope: "fixture", reason: "capture" };
    const signal = cameraSnapshot(active, UNKNOWN("local"), 100, false);
    assert.equal(signal.value, "unknown"); assert.equal(signal.reason, "renderer_restart_required_for_webcam_rule");
});

test("a lock before or simultaneous with blanking stays ambiguous even above the idle threshold", () => {
    for (const power of [0, 3]) {
        const d = new DisplayDetector(); d.observe(display({ idleMs: 301000 }));
        assert.equal(d.observe(display({ at: 2000, idleMs: 302000, locked: true, power })).value, "unknown");
        assert.equal(d.observe(display({ at: 3000, idleMs: 303000, locked: true, power: 3 })).value, "unknown");
    }
    const d = new DisplayDetector(); d.observe(display({ idleMs: 299000 }));
    assert.equal(d.observe(display({ at: 3000, idleMs: 301000, power: 3 })).value, "inactive");
    assert.equal(d.observe(display({ at: 4000, idleMs: 302000, power: 3, locked: true })).value, "inactive");
});
