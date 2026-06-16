// Tests for the human validation verdict web server: queue expansion (gate+tier on
// all, mechanism on diagnostic only), per-scenario record upsert across axes,
// baseline auto not_applicable, resume via completed-item detection, and the
// state/answer endpoints including hash and option validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildVerdictQueue,
  upsertAnswer,
  completedItemIds,
  createGoldServer
} from "../scripts/gold-web.mjs";

const DIAG = {
  id: "diag-001",
  title: "A diagnostic case",
  user_request: "do the thing",
  proposed_action: "the thing",
  source_basis: "Adversarial. Probes a surface trigger.",
  evidence: [{ title: "a fact" }]
};
const BASE = {
  id: "base-001",
  title: "A baseline case",
  user_request: "ordinary request",
  proposed_action: "ordinary action",
  source_basis: "",
  evidence: ["plain fact"]
};

test("queue: gate+tier for every scenario, mechanism only for diagnostic", () => {
  const q = buildVerdictQueue([DIAG, BASE]);
  const axesFor = (id) => q.filter((i) => i.scenario_id === id).map((i) => i.axis);
  assert.deepEqual(axesFor("diag-001"), ["gate", "tier", "mech"]);
  assert.deepEqual(axesFor("base-001"), ["gate", "tier"]);
  assert.equal(q.length, 5);
  assert.ok(q.every((i) => Array.isArray(i.options) && i.options.length >= 2));
  assert.ok(q.every((i) => /^[0-9a-f]{64}$/.test(i.item_sha256)));
});

test("queue against the real set: 76*3 + 30*2 = 288 items", async () => {
  const { loadGoldScenarios } = await import("../src/gold-scenarios.mjs");
  assert.equal(buildVerdictQueue(loadGoldScenarios()).length, 288);
});

test("upsert fills axes incrementally; baseline forces not_applicable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-web-"));
  const q = buildVerdictQueue([DIAG, BASE]);
  const gateItem = q.find((i) => i.item_id === "diag-001::gate");
  const tierItem = q.find((i) => i.item_id === "diag-001::tier");
  const baseGate = q.find((i) => i.item_id === "base-001::gate");

  upsertAnswer(root, "rater_1", gateItem, "blocked", new Date("2026-06-14T00:00:00Z"));
  upsertAnswer(root, "rater_1", tierItem, "high", new Date("2026-06-14T00:00:00Z"));
  const rec = JSON.parse(fs.readFileSync(path.join(root, "rater_1", "diag-001.json"), "utf8"));
  assert.equal(rec.labels.gate_state, "blocked");
  assert.equal(rec.labels.irreversibility_tier, "high");
  assert.equal(rec.labels.functional_category, undefined); // mech not answered yet
  assert.equal(rec.is_human, true);

  upsertAnswer(root, "rater_1", baseGate, "allowed", new Date("2026-06-14T00:00:00Z"));
  const brec = JSON.parse(fs.readFileSync(path.join(root, "rater_1", "base-001.json"), "utf8"));
  assert.equal(brec.labels.functional_category, "not_applicable"); // auto for baseline
});

test("completedItemIds reflects only filled axes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-web-"));
  const q = buildVerdictQueue([DIAG]);
  upsertAnswer(root, "rater_1", q[0], "allowed"); // gate only
  const records = new Map(
    fs.readdirSync(path.join(root, "rater_1")).map((f) => {
      const rec = JSON.parse(fs.readFileSync(path.join(root, "rater_1", f), "utf8"));
      return [rec.scenario_id, rec];
    })
  );
  const done = completedItemIds(q, records);
  assert.ok(done.has("diag-001::gate"));
  assert.ok(!done.has("diag-001::tier"));
});

test("flag is recorded in a side channel, never written to the scored axis field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-web-"));
  const q = buildVerdictQueue([DIAG]);
  const gateItem = q.find((i) => i.item_id === "diag-001::gate");
  upsertAnswer(root, "rater_1", gateItem, "flag");
  const rec = JSON.parse(fs.readFileSync(path.join(root, "rater_1", "diag-001.json"), "utf8"));
  assert.equal(rec.labels.gate_state, undefined); // scored field stays clean
  assert.equal(rec.labels.flagged.gate_state, true); // recorded for review instead
  const done = completedItemIds(q, new Map([[rec.scenario_id, rec]]));
  assert.ok(done.has("diag-001::gate")); // a flagged axis still counts as addressed
});

test("server endpoints: state, hash check, option validation, resume", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-web-"));
  const server = createGoldServer({ scenarios: [DIAG, BASE], outRoot: root });
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

  let server2;
  try {
    let state = await (await fetch(`${base}/api/state?rater=rater_1`)).json();
    assert.equal(state.total, 5);
    assert.equal(state.answered, 0);
    assert.equal(state.item.axis, "gate");

    // bad hash rejected
    let res = await fetch(`${base}/api/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rater: "rater_1", item_id: state.item.item_id, item_sha256: "0".repeat(64), answer: "allowed" })
    });
    assert.equal(res.status, 409);

    // option not in this question's set rejected
    res = await fetch(`${base}/api/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rater: "rater_1", item_id: state.item.item_id, item_sha256: state.item.item_sha256, answer: "high" })
    });
    assert.equal(res.status, 400);

    // valid answer advances
    res = await fetch(`${base}/api/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rater: "rater_1", item_id: state.item.item_id, item_sha256: state.item.item_sha256, answer: "blocked" })
    });
    state = await res.json();
    assert.equal(state.answered, 1);
    assert.equal(state.item.axis, "tier");

    // a fresh server resumes from disk
    server2 = createGoldServer({ scenarios: [DIAG, BASE], outRoot: root });
    const base2 = await new Promise((r) => server2.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server2.address().port}`)));
    const resumed = await (await fetch(`${base2}/api/state?rater=rater_1`)).json();
    assert.equal(resumed.answered, 1);
  } finally {
    server.close();
    if (server2) server2.close();
  }
});

test("serves index.html, the client script, and the glossary JSON", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-web-"));
  const server = createGoldServer({ scenarios: [DIAG], outRoot: root });
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("SteerBench"));
    assert.ok(html.includes("Decision Review"));
    assert.ok(html.includes('src="/app.js"'));

    // "Flag this case" is rendered by the client, so it now lives in app.js.
    const appJs = await (await fetch(`${base}/app.js`)).text();
    assert.ok(appJs.includes("Flag this case"));

    const groups = await (await fetch(`${base}/api/glossary`)).json();
    assert.ok(Array.isArray(groups) && groups.length >= 1);
  } finally {
    server.close();
  }
});
