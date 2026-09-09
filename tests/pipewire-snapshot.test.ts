// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { PipeWireDetector } from "../src/core/camera.ts";
import { pipeWireGraph } from "../src/core/pipeWireSnapshot.ts";

const core = [{ id: 0, type: "PipeWire:Interface:Core", info: { cookie: 7 } }];
const nodes = [
    { id: 2, type: "PipeWire:Interface:Node", info: { state: "running", props: { "object.serial": 12, "media.class": "Video/Source", "device.api": "v4l2", "api.v4l2.cap.driver": "uvcvideo", "device.serial": "excluded-fixture-value" } } },
    { id: 3, type: "PipeWire:Interface:Node", info: { state: "running", props: { "object.serial": 13, "media.class": "Stream/Input/Video", "application.name": "Example browser" } } }
];
const links = [{ id: 4, type: "PipeWire:Interface:Link", info: { state: "active", "output-node-id": 2, "input-node-id": 3 } }];
function fixture() { return [core, nodes, links, nodes, core].map(x => JSON.stringify(x)); }
function query(rows: (string | null)[]) { return async () => rows.shift() ?? null; }
test("filtered graph confirms a browser consumer without reading malformed Port parameters", async () => {
    const calls: string[] = [], rows = fixture(), budgets: number[] = [];
    const graph = await pipeWireGraph(async (selector, timeout, maxBytes) => { calls.push(selector); budgets.push(maxBytes); assert.ok(timeout > 0 && timeout <= 2000); return rows.shift()!; });
    assert.deepEqual(calls, ["0", "PipeWire:Interface:Node", "PipeWire:Interface:Link", "PipeWire:Interface:Node", "0"]);
    assert.equal(new PipeWireDetector().parse(graph!, 10).value, "active");
    assert.equal(budgets[0], 4 * 1024 * 1024);
    assert.ok(budgets.every((n, i) => n > 0 && (!i || n < budgets[i - 1])));
    assert.ok(!graph!.includes("Example browser") && !graph!.includes("excluded-fixture-value"));
});
test("capture cessation remains an explicit suspended-source observation", async () => {
    const detector = new PipeWireDetector();
    assert.equal(detector.parse((await pipeWireGraph(query(fixture())))!, 10).value, "active");
    const stopped = structuredClone(nodes); stopped[0].info.state = "suspended";
    const graph = await pipeWireGraph(query([core, stopped, [], stopped, core].map(x => JSON.stringify(x))));
    assert.equal(detector.parse(graph!, 20).value, "inactive");
});
test("node state, serial, topology or daemon changes invalidate the combined graph", async () => {
    for (const mutate of [
        (rows: string[]) => { const x = JSON.parse(rows[3]); x[0].info.state = "suspended"; rows[3] = JSON.stringify(x); },
        (rows: string[]) => { const x = JSON.parse(rows[3]); x[0].info.props["object.serial"]++; rows[3] = JSON.stringify(x); },
        (rows: string[]) => { rows[3] = "[]"; },
        (rows: string[]) => { rows[4] = JSON.stringify([{ ...core[0], info: { cookie: 8 } }]); }
    ]) { const rows = fixture(); mutate(rows); assert.equal(await pipeWireGraph(query(rows)), null); }
});
test("malformed, missing and unexpected filtered objects fail closed", async () => {
    for (const bad of [null, "[{\"info\":{\"params\":{[ ],[ ]}}}]", "{}", "[null]", JSON.stringify(links), JSON.stringify([nodes[0], nodes[0]]), JSON.stringify([{ id: 2, type: nodes[0].type, info: { state: "running" } }])]) {
        const rows: (string | null)[] = fixture(); rows[1] = bad;
        assert.equal(await pipeWireGraph(query(rows)), null);
    }
});
test("all queries share one time and output budget", async () => {
    let time = 0, calls = 0;
    const rows = fixture();
    assert.equal(await pipeWireGraph(async () => { calls++; time += 750; return rows.shift()!; }, () => time), null);
    assert.equal(calls, 3);
    assert.equal(await pipeWireGraph(query([" ".repeat(4 * 1024 * 1024) + "[]"])), null);
    time = 10;
    assert.equal(await pipeWireGraph(async () => { time = 0; return JSON.stringify(core); }, () => time), null);
});
