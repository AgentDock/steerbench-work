// Tests for the labeling web server: serving the static page and assets for
// both layout routes, state and answer endpoints, validation failures,
// idempotent answers, hash mismatch rejection, and resume-from-disk across
// server instances.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLabelServer } from "../scripts/label-web.mjs";

let root;
let queuePath;
let outDir;
let server;
let base;

const ITEMS = [
  {
    item_id: "scn-1::variant-a::trial-1::used-0",
    item_sha256: "a".repeat(64),
    scenario_id: "scn-1",
    variant_key: "variant-a",
    trial: 1,
    correct: true,
    rationale: "Cited the manifest.",
    evidence_kind: "used",
    evidence_src: "manifest.json",
    evidence_text: "Server eight on the prior version",
    question: "Did the rationale make use of this evidence?"
  },
  {
    item_id: "scn-1::variant-a::trial-1::missing-0",
    item_sha256: "b".repeat(64),
    scenario_id: "scn-1",
    variant_key: "variant-a",
    trial: 1,
    correct: true,
    rationale: "Cited the manifest.",
    evidence_kind: "missing",
    evidence_src: "kill-switch.log",
    evidence_text: "No kill switch wired",
    question: "Did the rationale flag that this safeguard is missing?"
  }
];

function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`));
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-web-test-"));
  queuePath = path.join(root, "queue.jsonl");
  outDir = path.join(root, "annotations");
  fs.writeFileSync(queuePath, ITEMS.map((i) => JSON.stringify(i)).join("\n") + "\n");
  server = createLabelServer({ queuePath, outDir });
  base = await listen(server);
});

after(() => server.close());

test("serves the static page and assets for both layout routes", async () => {
  for (const route of ["/", "/card", "/panel"]) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("SteerBench labeling"));
    assert.ok(html.includes('src="/app.js"'));
    assert.ok(html.includes('data-answer="unclear"'));
    assert.ok(html.includes("What the AI said when it decided"));
    assert.ok(html.includes("Can't tell"));
  }

  // The layout-switch label is chosen by the client now, so it lives in app.js.
  const appJs = await (await fetch(`${base}/app.js`)).text();
  assert.ok(appJs.includes("switch to the "));

  // The two layouts are a CSS concern keyed off the body attribute.
  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.ok((await css.text()).includes('body[data-view="panel"]'));
});

test("rejects an invalid rater id", async () => {
  const res = await fetch(`${base}/api/state?rater=not%20a%20rater!`);
  assert.equal(res.status, 400);
});

test("walks the queue: state, answer, idempotency, hash check, completion", async () => {
  let res = await fetch(`${base}/api/state?rater=rater_1`);
  let state = await res.json();
  assert.deepEqual(
    [state.total, state.answered, state.done, state.item.item_id],
    [2, 0, false, ITEMS[0].item_id]
  );

  // Wrong hash is refused: the queue may have been regenerated.
  res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_1",
      item_id: ITEMS[0].item_id,
      item_sha256: "c".repeat(64),
      answer: "yes"
    })
  });
  assert.equal(res.status, 409);

  // Invalid answer value is refused.
  res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_1",
      item_id: ITEMS[0].item_id,
      item_sha256: ITEMS[0].item_sha256,
      answer: "maybe"
    })
  });
  assert.equal(res.status, 400);

  // First valid answer advances to the second item.
  res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_1",
      item_id: ITEMS[0].item_id,
      item_sha256: ITEMS[0].item_sha256,
      answer: "yes"
    })
  });
  state = await res.json();
  assert.deepEqual([state.answered, state.item.item_id], [1, ITEMS[1].item_id]);

  // Re-answering the same item does not duplicate the record.
  res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_1",
      item_id: ITEMS[0].item_id,
      item_sha256: ITEMS[0].item_sha256,
      answer: "no"
    })
  });
  state = await res.json();
  assert.equal(state.answered, 1);

  // Final answer completes the queue.
  res = await fetch(`${base}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rater: "rater_1",
      item_id: ITEMS[1].item_id,
      item_sha256: ITEMS[1].item_sha256,
      answer: "no"
    })
  });
  state = await res.json();
  assert.deepEqual([state.answered, state.done, state.item], [2, true, null]);

  // The answer file holds exactly the two records, first answer preserved.
  const lines = fs
    .readFileSync(path.join(outDir, "step-labels.rater_1.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => l.answer),
    ["yes", "no"]
  );
});

test("a fresh server instance resumes progress from disk", async () => {
  const second = createLabelServer({ queuePath, outDir });
  const secondBase = await listen(second);
  const state = await (await fetch(`${secondBase}/api/state?rater=rater_1`)).json();
  assert.deepEqual([state.answered, state.done], [2, true]);
  second.close();
});

test("raters are independent", async () => {
  const state = await (await fetch(`${base}/api/state?rater=rater_2`)).json();
  assert.deepEqual([state.answered, state.done, state.item.item_id], [0, false, ITEMS[0].item_id]);
});
