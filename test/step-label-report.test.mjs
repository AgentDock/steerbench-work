// Tests for the agreement/adjudication report: matrix shape, exact
// agreement, Fleiss kappa behavior, flag routing, and the calibration
// scoring path in the labeling server.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReport, fleissKappa } from "../scripts/step-label-report.mjs";
import { createLabelServer } from "../scripts/label-web.mjs";

const QUEUE = [
  { item_id: "i-1", item_sha256: "a".repeat(64) },
  { item_id: "i-2", item_sha256: "b".repeat(64) },
  { item_id: "i-3", item_sha256: "c".repeat(64) }
];

function ratersFrom(spec) {
  // spec: { rater: { item_id: answer } }
  return new Map(Object.entries(spec).map(([r, a]) => [r, new Map(Object.entries(a))]));
}

test("perfect agreement gives kappa 1 and an empty adjudication queue", () => {
  const report = buildReport(
    QUEUE,
    ratersFrom({
      rater_1: { "i-1": "yes", "i-2": "no", "i-3": "unclear" },
      rater_2: { "i-1": "yes", "i-2": "no", "i-3": "unclear" },
      rater_3: { "i-1": "yes", "i-2": "no", "i-3": "unclear" }
    })
  );
  assert.equal(report.exact_agreement, 1);
  assert.equal(report.fleiss_kappa, 1);
  assert.deepEqual(report.adjudication_queue, []);
});

test("splits and flags route to adjudication; flags are not judgments", () => {
  const report = buildReport(
    QUEUE,
    ratersFrom({
      rater_1: { "i-1": "yes", "i-2": "yes", "i-3": "flag" },
      rater_2: { "i-1": "yes", "i-2": "no", "i-3": "yes" },
      rater_3: { "i-1": "yes", "i-2": "no", "i-3": "yes" }
    })
  );
  // i-2 is a 2-1 split; i-3 has a flag (two real judgments agree).
  assert.deepEqual(report.adjudication_queue, ["i-2", "i-3"]);
  const i3 = report.items.find((i) => i.item_id === "i-3");
  assert.equal(i3.flags, 1);
  // i-1 and i-3 fully agree among non-flag judgments; i-2 does not.
  assert.equal(report.comparable_items, 3);
  assert.equal(report.exact_agreement, Number((2 / 3).toFixed(3)));
});

test("kappa is null when no item has two judgments", () => {
  assert.equal(fleissKappa([[1, 0, 0]]), null);
  const report = buildReport(QUEUE, ratersFrom({ rater_1: { "i-1": "yes" } }));
  assert.equal(report.fleiss_kappa, null);
  assert.equal(report.exact_agreement, null);
});

test("calibration mode scores a finished rater against the key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cal-test-"));
  const queuePath = path.join(root, "queue.jsonl");
  const keyPath = path.join(root, "key.json");
  const outDir = path.join(root, "annotations");
  fs.writeFileSync(
    queuePath,
    QUEUE.map((q) => JSON.stringify({ ...q, scenario_id: "s", variant_key: "v", trial: 1,
      rationale: "r", evidence_kind: "used", evidence_src: "e", evidence_text: "t",
      question: "q" })).join("\n") + "\n"
  );
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      status: "draft-pending-adjudication",
      pass_bar: 0.8,
      items: {
        "i-1": { answer: "yes" },
        "i-2": { answer: "no" },
        "i-3": { answer: "unclear" }
      }
    })
  );
  const server = createLabelServer({ queuePath, outDir, calibrationKeyPath: keyPath });
  const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const post = (itemId, sha, answer) =>
    fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rater: "rater_9", item_id: itemId, item_sha256: sha, answer })
    });

  await post("i-1", "a".repeat(64), "yes");      // match
  await post("i-2", "b".repeat(64), "yes");      // mismatch (key says no)
  const res = await post("i-3", "c".repeat(64), "unclear"); // match
  const state = await res.json();

  assert.equal(state.done, true);
  assert.equal(state.calibration.matched, 2);
  assert.equal(state.calibration.keyed, 3);
  assert.equal(state.calibration.passed, false); // 0.667 below the 0.8 bar
  assert.equal(state.calibration.provisional, true);
  assert.deepEqual(state.calibration.mismatches, [
    { item_id: "i-2", expected: "no", got: "yes" }
  ]);
  const reportFile = path.join(outDir, "calibration-report.rater_9.json");
  assert.ok(fs.existsSync(reportFile));
  server.close();
});

test("flag is an accepted answer value end to end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flag-test-"));
  const queuePath = path.join(root, "queue.jsonl");
  const outDir = path.join(root, "annotations");
  fs.writeFileSync(
    queuePath,
    JSON.stringify({ ...QUEUE[0], scenario_id: "s", variant_key: "v", trial: 1,
      rationale: "r", evidence_kind: "used", evidence_src: "e", evidence_text: "t",
      question: "q" }) + "\n"
  );
  const server = createLabelServer({ queuePath, outDir });
  const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_8", item_id: "i-1", item_sha256: "a".repeat(64), answer: "flag"
    })
  });
  assert.equal(res.status, 200);
  const lines = fs
    .readFileSync(path.join(outDir, "step-labels.rater_8.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].answer, "flag");
  server.close();
});
