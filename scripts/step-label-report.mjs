#!/usr/bin/env node
/**
 * @fileoverview Agreement and adjudication report over step-label answers.
 * @module scripts/step-label-report
 *
 * Reads every per-rater answer file for a queue and produces the quality
 * picture an annotation pass runs on: per-item answer matrix, exact
 * agreement, Fleiss kappa across raters, and the adjudication queue (every
 * item with a disagreement or a flag). Flags never count as judgments;
 * they route the item to review.
 *
 * @remarks
 * - Agreement below the working bar means the guidelines are ambiguous;
 *   the fix is the next guidelines version, never mid-pass edits.
 * - Kappa is computed over items with at least two non-flag answers, with
 *   categories yes / no / unclear.
 *
 * Usage:
 * ```bash
 * node scripts/step-label-report.mjs --queue annotations/step-label-queue.jsonl \
 *   [--labels-dir annotations] [--out annotations/step-label-report.json]
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/step-label-report.mjs --queue <file> [--labels-dir <dir>] [--out <file>]

Builds the per-item answer matrix, exact agreement, Fleiss kappa, and the
adjudication queue (disagreements + flags) from step-labels.<rater>.jsonl
files. Offline; never calls a model API.`;

const CATEGORIES = ["yes", "no", "unclear"];

/** Reads all rater answer files in a directory, keyed by rater id. */
function readAllAnswers(labelsDir) {
  const byRater = new Map();
  for (const name of fs.readdirSync(labelsDir)) {
    const match = name.match(/^step-labels\.([a-z0-9_-]{1,16})\.jsonl$/i);
    if (!match) continue;
    const answers = new Map();
    for (const line of fs.readFileSync(path.join(labelsDir, name), "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      answers.set(record.item_id, record.answer);
    }
    byRater.set(match[1], answers);
  }
  return byRater;
}

/**
 * Fleiss kappa over an items-by-categories count table. Items with fewer
 * than two ratings are excluded (kappa requires comparison).
 *
 * @param countRows - one array per item: counts per category
 * @returns kappa, or null when no item has two or more ratings
 */
export function fleissKappa(countRows) {
  const rows = countRows.filter((counts) => counts.reduce((a, b) => a + b, 0) >= 2);
  if (rows.length === 0) return null;
  let sumPi = 0;
  const categoryTotals = new Array(rows[0].length).fill(0);
  let totalRatings = 0;
  for (const counts of rows) {
    const n = counts.reduce((a, b) => a + b, 0);
    totalRatings += n;
    counts.forEach((c, j) => {
      categoryTotals[j] += c;
    });
    sumPi += (counts.reduce((a, c) => a + c * c, 0) - n) / (n * (n - 1));
  }
  const pBar = sumPi / rows.length;
  const pe = categoryTotals.reduce((a, t) => a + (t / totalRatings) ** 2, 0);
  if (pe === 1) return 1;
  return (pBar - pe) / (1 - pe);
}

/**
 * Builds the report object for a queue plus a set of rater answer maps.
 * Exported for tests.
 */
export function buildReport(queueItems, byRater) {
  const raters = [...byRater.keys()].sort();
  const items = [];
  const kappaRows = [];
  let fullAgreement = 0;
  let comparable = 0;

  for (const item of queueItems) {
    const answers = {};
    let flags = 0;
    const counts = new Array(CATEGORIES.length).fill(0);
    for (const rater of raters) {
      const answer = byRater.get(rater).get(item.item_id);
      if (answer === undefined) continue;
      answers[rater] = answer;
      if (answer === "flag") {
        flags += 1;
      } else {
        const idx = CATEGORIES.indexOf(answer);
        if (idx >= 0) counts[idx] += 1;
      }
    }
    const judged = counts.reduce((a, b) => a + b, 0);
    const distinct = counts.filter((c) => c > 0).length;
    const disagreement = distinct > 1;
    if (judged >= 2) {
      comparable += 1;
      if (!disagreement) fullAgreement += 1;
      kappaRows.push(counts);
    }
    const needsAdjudication = disagreement || flags > 0;
    items.push({
      item_id: item.item_id,
      answers,
      flags,
      needs_adjudication: needsAdjudication
    });
  }

  const kappa = fleissKappa(kappaRows);
  return {
    raters,
    item_count: queueItems.length,
    comparable_items: comparable,
    exact_agreement: comparable > 0 ? Number((fullAgreement / comparable).toFixed(3)) : null,
    fleiss_kappa: kappa === null ? null : Number(kappa.toFixed(3)),
    adjudication_queue: items.filter((i) => i.needs_adjudication).map((i) => i.item_id),
    items
  };
}

function parseArgs(argv) {
  const args = { queue: null, labelsDir: "annotations", out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--help" || flag === "-h") return { help: true };
    else if (flag === "--queue") args.queue = next();
    else if (flag === "--labels-dir") args.labelsDir = next();
    else if (flag === "--out") args.out = next();
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!args.queue) throw new Error("--queue is required");
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
  const queueItems = fs
    .readFileSync(args.queue, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const report = buildReport(queueItems, readAllAnswers(args.labelsDir));
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `raters: ${report.raters.length} | items: ${report.item_count} | ` +
      `comparable: ${report.comparable_items} | exact agreement: ${report.exact_agreement} | ` +
      `Fleiss kappa: ${report.fleiss_kappa} | adjudication queue: ${report.adjudication_queue.length}`
  );
}
