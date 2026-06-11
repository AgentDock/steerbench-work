#!/usr/bin/env node
/**
 * @fileoverview Local web interface for step-evidence labeling.
 * @module scripts/label-web
 *
 * Serves a single-page, keyboard-first labeling screen over a queue built
 * by build-step-label-queue.mjs. Each rater answers one binary question per
 * item (yes / no / unclear); answers append to one JSONL file per rater
 * under the output directory. The session is resumable: progress is derived
 * from the answer file on every request, so restarting the server or the
 * browser never loses work.
 *
 * @remarks
 * - Zero dependencies, same as the rest of the runner. One Node http server,
 *   one embedded HTML page, no external assets, binds 127.0.0.1 only.
 * - Rater ids follow the anonymization convention of the CLI labeler
 *   (e.g. rater_1). Real names never enter the repository.
 * - Answers are refused when the submitted item_sha256 does not match the
 *   queue item, so answers can never silently attach to regenerated items.
 *
 * Usage:
 * ```bash
 * node scripts/label-web.mjs --queue annotations/step-label-queue.jsonl \
 *   [--out-dir annotations] [--port 4400]
 * ```
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/label-web.mjs --queue <file> [--out-dir <dir>] [--port N]

Serves the step-evidence labeling interface on 127.0.0.1. Answers append to
<out-dir>/step-labels.<rater>.jsonl. Resumable; offline; no model API calls.`;

const RATER_RE = /^[a-z0-9_-]{1,16}$/i;
const ANSWERS = new Set(["yes", "no", "unclear"]);

/** Loads the queue JSONL into an ordered array plus an id index. */
function loadQueue(queuePath) {
  const lines = fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean);
  const items = lines.map((line) => JSON.parse(line));
  const byId = new Map(items.map((item) => [item.item_id, item]));
  if (byId.size !== items.length) throw new Error("Duplicate item_id in queue");
  return { items, byId };
}

function answerFileFor(outDir, rater) {
  return path.join(outDir, `step-labels.${rater}.jsonl`);
}

/** Reads a rater's answer file into a Map of item_id to record. */
function readAnswers(outDir, rater) {
  const file = answerFileFor(outDir, rater);
  const answered = new Map();
  if (!fs.existsSync(file)) return answered;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    answered.set(record.item_id, record);
  }
  return answered;
}

/** Public item view: everything the rater needs, nothing they should not see. */
function itemView(item) {
  return {
    item_id: item.item_id,
    item_sha256: item.item_sha256,
    scenario_id: item.scenario_id,
    variant_key: item.variant_key,
    trial: item.trial,
    rationale: item.rationale,
    evidence_kind: item.evidence_kind,
    evidence_src: item.evidence_src,
    evidence_text: item.evidence_text,
    question: item.question
  };
}

function stateFor(queue, outDir, rater) {
  const answered = readAnswers(outDir, rater);
  const next = queue.items.find((item) => !answered.has(item.item_id));
  return {
    rater,
    total: queue.items.length,
    answered: answered.size,
    done: !next,
    item: next ? itemView(next) : null
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Creates the labeling HTTP server. Exported for tests.
 *
 * @param options - queuePath and outDir
 * @returns A Node http.Server (not yet listening)
 */
export function createLabelServer({ queuePath, outDir }) {
  const queue = loadQueue(queuePath);
  fs.mkdirSync(outDir, { recursive: true });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const rater = url.searchParams.get("rater") ?? "";
      if (!RATER_RE.test(rater)) {
        sendJson(res, 400, { error: "Invalid rater id (letters, digits, _ or -, max 16)" });
        return;
      }
      sendJson(res, 200, stateFor(queue, outDir, rater));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/answer") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const { rater, item_id: itemId, item_sha256: itemSha, answer } = body ?? {};
      if (!RATER_RE.test(rater ?? "")) {
        sendJson(res, 400, { error: "Invalid rater id" });
        return;
      }
      if (!ANSWERS.has(answer)) {
        sendJson(res, 400, { error: "Answer must be yes, no, or unclear" });
        return;
      }
      const item = queue.byId.get(itemId);
      if (!item) {
        sendJson(res, 404, { error: "Unknown item_id" });
        return;
      }
      if (item.item_sha256 !== itemSha) {
        sendJson(res, 409, { error: "item_sha256 mismatch; queue was regenerated" });
        return;
      }
      const answered = readAnswers(outDir, rater);
      if (!answered.has(itemId)) {
        const record = {
          item_id: itemId,
          item_sha256: itemSha,
          rater,
          answer,
          answered_at: new Date().toISOString()
        };
        fs.appendFileSync(answerFileFor(outDir, rater), `${JSON.stringify(record)}\n`);
      }
      sendJson(res, 200, stateFor(queue, outDir, rater));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SteerBench step labeling</title>
<style>
  :root { --blue: #4F6EF7; --ink: #1a1a1a; --muted: #6b7280; --line: #e5e7eb; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: var(--ink); background: #fafafa; }
  main { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 18px; font-weight: 600; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 24px; }
  .meta { font-size: 12px; color: var(--muted); font-family: ui-monospace, Menlo, monospace;
          margin-bottom: 16px; }
  .progress { height: 4px; background: var(--line); border-radius: 2px; margin: 12px 0 24px; }
  .progress > div { height: 100%; background: var(--blue); border-radius: 2px; width: 0; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
           color: var(--muted); margin: 18px 0 6px; }
  .rationale { white-space: pre-wrap; line-height: 1.55; }
  .evidence { border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
  .evidence .src { font-family: ui-monospace, Menlo, monospace; font-size: 12px;
                   color: var(--muted); }
  .question { font-weight: 600; margin: 22px 0 14px; }
  button { font: inherit; padding: 10px 22px; border-radius: 6px; border: 1px solid var(--line);
           background: #fff; cursor: pointer; margin-right: 10px; }
  button:hover { border-color: var(--blue); }
  button .key { color: var(--muted); font-size: 12px; margin-left: 6px; }
  #gate input { font: inherit; padding: 8px 10px; border: 1px solid var(--line);
                border-radius: 6px; margin-right: 10px; }
  .done { text-align: center; padding: 40px 0; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 20px; }
</style>
</head>
<body>
<main>
  <h1>SteerBench step labeling</h1>

  <div id="gate" class="card">
    <p>Enter your rater id (e.g. <code>rater_1</code>). Use your assigned id, not your name.</p>
    <input id="rater-input" placeholder="rater_1" autocomplete="off">
    <button id="start">Start</button>
    <p id="gate-error" style="color:#b91c1c"></p>
  </div>

  <div id="work" class="card" style="display:none">
    <div class="meta"><span id="counter"></span> &middot; <span id="context"></span></div>
    <div class="progress"><div id="bar"></div></div>
    <div class="label">Model's rationale</div>
    <div class="rationale" id="rationale"></div>
    <div class="label" id="evidence-label"></div>
    <div class="evidence"><div class="src" id="evidence-src"></div><div id="evidence-text"></div></div>
    <div class="question" id="question"></div>
    <div>
      <button data-answer="yes">Yes<span class="key">Y</span></button>
      <button data-answer="no">No<span class="key">N</span></button>
      <button data-answer="unclear">Unclear<span class="key">U</span></button>
    </div>
    <p class="hint">Keyboard: Y / N / U. Every answer saves immediately; close and resume anytime.</p>
  </div>

  <div id="finished" class="card done" style="display:none">
    <p><strong>All items answered.</strong></p>
    <p id="summary"></p>
  </div>
</main>
<script>
(() => {
  let rater = localStorage.getItem("sb-rater") || "";
  let current = null;

  const el = (id) => document.getElementById(id);

  function show(state) {
    el("gate").style.display = "none";
    if (state.done) {
      el("work").style.display = "none";
      el("finished").style.display = "block";
      el("summary").textContent =
        state.answered + " answers saved for " + state.rater +
        " in annotations/step-labels." + state.rater + ".jsonl";
      return;
    }
    current = state.item;
    el("work").style.display = "block";
    el("counter").textContent = "item " + (state.answered + 1) + " of " + state.total;
    el("context").textContent = current.scenario_id + " / " + current.variant_key +
      " / trial " + current.trial;
    el("bar").style.width = (100 * state.answered / state.total) + "%";
    el("rationale").textContent = current.rationale;
    el("evidence-label").textContent = current.evidence_kind === "missing"
      ? "Missing safeguard (from the scenario)"
      : "Evidence the decision should rest on (from the scenario)";
    el("evidence-src").textContent = current.evidence_src;
    el("evidence-text").textContent = current.evidence_text;
    el("question").textContent = current.question;
  }

  async function refresh() {
    const res = await fetch("/api/state?rater=" + encodeURIComponent(rater));
    const state = await res.json();
    if (!res.ok) { el("gate-error").textContent = state.error; return; }
    show(state);
  }

  async function answer(value) {
    if (!current) return;
    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rater, item_id: current.item_id, item_sha256: current.item_sha256, answer: value
      })
    });
    const state = await res.json();
    if (res.ok) show(state);
  }

  el("start").addEventListener("click", () => {
    rater = el("rater-input").value.trim();
    localStorage.setItem("sb-rater", rater);
    refresh();
  });
  document.querySelectorAll("button[data-answer]").forEach((b) =>
    b.addEventListener("click", () => answer(b.dataset.answer)));
  document.addEventListener("keydown", (e) => {
    if (el("work").style.display === "none") return;
    if (e.key === "y" || e.key === "Y") answer("yes");
    if (e.key === "n" || e.key === "N") answer("no");
    if (e.key === "u" || e.key === "U") answer("unclear");
  });

  if (rater) { el("rater-input").value = rater; }
})();
</script>
</body>
</html>
`;

function parseArgs(argv) {
  const args = {
    queue: path.join("annotations", "step-label-queue.jsonl"),
    outDir: "annotations",
    port: 4400,
    host: "127.0.0.1"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--help" || flag === "-h") return { help: true };
    else if (flag === "--queue") args.queue = next();
    else if (flag === "--out-dir") args.outDir = next();
    else if (flag === "--port") args.port = Number(next());
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message ?? error));
    console.error(USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const server = createLabelServer({ queuePath: args.queue, outDir: args.outDir });
  server.listen(args.port, args.host, () => {
    const { items } = loadQueue(args.queue);
    console.log(`Labeling ${items.length} items from ${args.queue}`);
    console.log(`Answers append to ${args.outDir}/step-labels.<rater>.jsonl`);
    console.log(`Open http://${args.host}:${args.port}/`);
  });
}
