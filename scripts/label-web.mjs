#!/usr/bin/env node
/**
 * @fileoverview Local web interface for step-evidence labeling.
 * @module scripts/label-web
 *
 * Serves a plain-language, keyboard-first labeling screen over a queue
 * built by build-step-label-queue.mjs. Each rater answers one binary
 * question per item (yes / no / can't tell); answers append to one JSONL
 * file per rater under the output directory. The session is resumable:
 * progress is derived from the answer file on every request, so restarting
 * the server or the browser never loses work.
 *
 * Two switchable layouts, mirroring the two patterns annotation tools
 * converge on: a focused single card (one judgment, no surroundings) and a
 * two-panel view (content on the left, question form on the right). Both
 * render the same items through the same API; the layout is chosen by the URL
 * path (/card or /panel) and applied in CSS, with no server-side branching.
 *
 * @remarks
 * - Zero dependencies, same as the rest of the runner. One Node http server.
 *   The browser code is a real static asset (scripts/review-steps/), served
 *   from a fixed allowlist so no request path is ever mapped to disk. Binds
 *   127.0.0.1 only.
 * - Raters see plain language: the scenario's title as the situation, the
 *   model's explanation, one fact, one question. Scenario ids, variant keys,
 *   and source refs live in fine print for traceability, not in the rater's
 *   reading path.
 * - Rater ids follow the anonymization convention of the CLI labeler
 *   (e.g. rater_1). Real names never enter the repository.
 * - Answers are refused when the submitted item_sha256 does not match the
 *   queue item, so answers can never silently attach to regenerated items.
 *
 * Usage:
 * ```bash
 * node scripts/label-web.mjs --queue annotations/step-label-queue.jsonl \
 *   [--out-dir annotations] [--port 4400] [--calibration-key <file>]
 * ```
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATER_RE = /^[a-z0-9_-]{1,16}$/i;
const ANSWERS = new Set(["yes", "no", "unclear", "flag"]);

// The browser code lives as static files; /card and /panel both serve the same
// page and the client picks the layout from the path. The allowlist is fixed, so
// no user-controlled path is ever resolved against the filesystem.
const REVIEW_DIR = path.join(runnerRoot, "scripts", "review-steps");
const ASSETS = Object.freeze({
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/card": { file: "index.html", type: "text/html; charset=utf-8" },
  "/panel": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
});

const USAGE = `Usage: node scripts/label-web.mjs --queue <file> [--out-dir <dir>] [--port N] [--calibration-key <file>]

Serves the step-evidence labeling interface on 127.0.0.1. Two layouts:
/card (focused card) and /panel (content left, question right). Answers
append to <out-dir>/step-labels.<rater>.jsonl. With --calibration-key the
finish screen scores the rater against the key (qualification mode) and
writes <out-dir>/calibration-report.<rater>.json. Resumable; offline; no
model API calls.`;

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
    scenario_title: item.scenario_title ?? "",
    variant_key: item.variant_key,
    trial: item.trial,
    rationale: item.rationale,
    evidence_kind: item.evidence_kind,
    evidence_src: item.evidence_src,
    evidence_text: item.evidence_text,
    question: item.question
  };
}

/**
 * Scores a finished rater against a calibration key. Only keyed items
 * count; a flag on a keyed item is a mismatch (the key holder settled it,
 * so "cannot judge" disagrees with the key).
 */
function calibrationResult(calKey, answered) {
  const entries = Object.entries(calKey.items ?? {});
  const passBar = calKey.pass_bar ?? 0.8;
  const mismatches = [];
  let matched = 0;
  for (const [itemId, expected] of entries) {
    const got = answered.get(itemId)?.answer ?? null;
    if (got === expected.answer) matched += 1;
    else mismatches.push({ item_id: itemId, expected: expected.answer, got });
  }
  const score = entries.length > 0 ? matched / entries.length : 0;
  return {
    matched,
    keyed: entries.length,
    score: Number(score.toFixed(3)),
    pass_bar: passBar,
    passed: score >= passBar,
    provisional: calKey.status !== "adjudicated",
    mismatches
  };
}

function stateFor(queue, outDir, rater, calKey) {
  const answered = readAnswers(outDir, rater);
  const next = queue.items.find((item) => !answered.has(item.item_id));
  const state = {
    rater,
    total: queue.items.length,
    answered: answered.size,
    done: !next,
    item: next ? itemView(next) : null
  };
  if (state.done && calKey) {
    state.calibration = calibrationResult(calKey, answered);
    fs.writeFileSync(
      path.join(outDir, `calibration-report.${rater}.json`),
      `${JSON.stringify({ rater, generated_at: new Date().toISOString(), ...state.calibration }, null, 2)}\n`
    );
  }
  return state;
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
 * @param options - queuePath, outDir, and optional calibrationKeyPath
 * @returns A Node http.Server (not yet listening)
 */
export function createLabelServer({ queuePath, outDir, calibrationKeyPath }) {
  const queue = loadQueue(queuePath);
  const calKey = calibrationKeyPath
    ? JSON.parse(fs.readFileSync(calibrationKeyPath, "utf8"))
    : null;
  fs.mkdirSync(outDir, { recursive: true });

  // Static assets are read once at boot from the fixed allowlist (no request
  // path is ever mapped to disk, so directory traversal cannot occur).
  const staticAssets = {};
  for (const route of Object.keys(ASSETS)) {
    const { file: assetFile, type } = ASSETS[route];
    staticAssets[route] = { type, body: fs.readFileSync(path.join(REVIEW_DIR, assetFile)) };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && staticAssets[url.pathname]) {
      const asset = staticAssets[url.pathname];
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(asset.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const rater = url.searchParams.get("rater") ?? "";
      if (!RATER_RE.test(rater)) {
        sendJson(res, 400, { error: "Invalid rater id (letters, digits, _ or -, max 16)" });
        return;
      }
      sendJson(res, 200, stateFor(queue, outDir, rater, calKey));
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
        sendJson(res, 400, { error: "Answer must be yes, no, unclear, or flag" });
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
      sendJson(res, 200, stateFor(queue, outDir, rater, calKey));
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
}

function parseArgs(argv) {
  const args = {
    queue: path.join("annotations", "step-label-queue.jsonl"),
    outDir: "annotations",
    port: 4400
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--help" || flag === "-h") return { help: true };
    else if (flag === "--queue") args.queue = next();
    else if (flag === "--out-dir") args.outDir = next();
    else if (flag === "--port") {
      const p = Number(next());
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("--port must be an integer in 0-65535");
      args.port = p;
    } else if (flag === "--calibration-key") args.calibrationKeyPath = next();
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
  const server = createLabelServer({
    queuePath: args.queue,
    outDir: args.outDir,
    calibrationKeyPath: args.calibrationKeyPath
  });
  server.listen(args.port, "127.0.0.1", () => {
    const { items } = loadQueue(args.queue);
    console.log(`Labeling ${items.length} items from ${args.queue}`);
    console.log(`Answers append to ${args.outDir}/step-labels.<rater>.jsonl`);
    console.log(`Focused card: http://127.0.0.1:${args.port}/card`);
    console.log(`Two-panel:    http://127.0.0.1:${args.port}/panel`);
  });
}
