#!/usr/bin/env node
/**
 * @fileoverview Human labeling CLI for the annotation axes (gate,
 * functional_category, irreversibility).
 * @module scripts/label
 *
 * Produces independent human reference labels in the same record shape the
 * annotator panel emits, so the existing agreement scorer computes human-vs-
 * human and human-vs-panel agreement without changes.
 *
 * @remarks
 * - Each scenario is shown through {@link redactScenario}: the answer-key
 *   fields are hidden, so the rater judges from the same evidence the model
 *   under test received.
 * - The rater is an anonymized id passed via `--rater` (e.g. `rater_1`). A real
 *   name is never written; any id-to-person mapping stays out of the repo.
 * - One record per (scenario, rater) is written to
 *   runs/human-labels/<rater>/<scenario_id>.json. The run is resumable: an
 *   existing record for a pair is skipped.
 *
 * Usage:
 * ```bash
 * node scripts/label.mjs --rater rater_1
 * node scripts/label.mjs --rater rater_2 --scenarios-file ids.json
 * ```
 * Single-key answers, then Enter. `s` skips a scenario; `q` saves and quits.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { redactScenario } from "../src/annotator-panel.mjs";
import { loadGoldScenarios, isDiagnostic } from "../src/gold-scenarios.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.join(__dirname, "..");

/** Gate choices: a human picks one. proceed -> allowed, block -> blocked. */
const GATE = Object.freeze({ p: { value: "allowed", label: "proceed (the agent SHOULD act)" }, b: { value: "blocked", label: "block / hold for review" } });

/** Mechanism choices: the 4 failure mechanisms + not-applicable. Values match
 * the model panel's vocabulary so human-vs-panel agreement aligns. */
const MECH = Object.freeze({
  1: "lexical-overfitting",
  2: "instruction-hierarchy-confusion",
  3: "missing-information",
  4: "unwarranted-abstention",
  5: "not_applicable"
});

/** Irreversibility tiers. */
const TIER = Object.freeze({ l: "low", m: "medium", h: "high" });

/**
 * Parse CLI args.
 *
 * @param {string[]} argv
 * @returns {{ rater: string|null, scenariosFile: string|null, outDir: string }}
 */
function parseArgs(argv) {
  const args = { rater: null, scenariosFile: null, outDir: path.join(runnerRoot, "runs", "human-labels") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rater") args.rater = argv[++i];
    else if (a === "--scenarios-file") args.scenariosFile = argv[++i];
    else if (a === "--out") args.outDir = argv[++i];
  }
  return args;
}

/**
 * Load all 106 scenarios (gate + irreversibility apply to every one),
 * optionally filtered to an explicit id list. Diagnostic vs baseline is
 * decided later per scenario by {@link isDiagnostic}.
 *
 * @param {string|null} scenariosFile
 * @returns {object[]} raw scenario objects
 */
function loadScenarios(scenariosFile) {
  const all = loadGoldScenarios();
  if (!scenariosFile) return all;
  const ids = new Set(JSON.parse(fs.readFileSync(scenariosFile, "utf8")));
  return all.filter((s) => ids.has(s.id));
}

/**
 * Render the human-facing view of a redacted scenario: the same evidence the
 * model saw, formatted for reading. Answer-key fields are already stripped by
 * redactScenario.
 *
 * @param {object} scenario - raw scenario (redacted inside)
 * @returns {string}
 */
function renderScenario(scenario) {
  const r = redactScenario(scenario);
  const request = r.user_request ?? r.event?.user_request ?? "(none)";
  const action = r.proposed_action ?? r.event?.proposed_action ?? "(none)";
  const actionType = r.action_type ?? r.event?.action_type ?? "";
  const refusal = typeof r.refusal_quote === "string" && r.refusal_quote.trim() ? r.refusal_quote.trim() : null;
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.map((e, i) => `    ${i + 1}. ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n")
    : "(none)";
  const lines = [
    "",
    "  USER REQUEST:",
    `    ${String(request).replace(/\n/g, "\n    ")}`,
    "",
    `  PROPOSED ACTION${actionType ? ` [${actionType}]` : ""}:`,
    `    ${typeof action === "string" ? action.replace(/\n/g, "\n    ") : JSON.stringify(action)}`,
    "",
    "  EVIDENCE AVAILABLE:",
    evidence
  ];
  if (refusal) lines.push("", "  OBSERVED MODEL BEHAVIOR (the refusal it produced):", `    ${refusal.replace(/\n/g, "\n    ")}`);
  lines.push("", "  (press j then Enter to dump the full redacted JSON the panel saw)");
  return lines.join("\n");
}

/**
 * Build a line-buffered prompter over a readline interface. Works for both an
 * interactive TTY (lines arrive as typed) and piped stdin (lines pre-buffered):
 * readline 'line' events are queued and consumed in order, so sequential
 * prompts never drop buffered input. Plain `rl.question` loses buffered lines
 * across calls when stdin is a pipe.
 *
 * @param {readline.Interface} rl
 * @returns {(prompt: string) => Promise<string>}
 */
function makePrompter(rl) {
  const queue = [];
  const waiters = [];
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line.trim());
    else queue.push(line.trim());
  });
  return (prompt) =>
    new Promise((resolve) => {
      process.stdout.write(prompt);
      const q = queue.shift();
      if (q !== undefined) resolve(q);
      else waiters.push(resolve);
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rater || !/^[a-z0-9_]+$/i.test(args.rater)) {
    console.error('Pass an anonymized rater id, e.g.  node scripts/label.mjs --rater rater_1\n(letters/digits/underscore only; NEVER a real name)');
    process.exit(1);
  }
  const scenarios = loadScenarios(args.scenariosFile);
  const outDir = path.join(args.outDir, args.rater);
  fs.mkdirSync(outDir, { recursive: true });

  const todo = scenarios.filter((s) => !fs.existsSync(path.join(outDir, `${s.id}.json`)));
  const done = scenarios.length - todo.length;
  console.log(`\nSteerBench-Work human labeling  |  rater: ${args.rater}`);
  console.log(`scenarios: ${scenarios.length}   already labeled: ${done}   remaining: ${todo.length}\n`);
  if (todo.length === 0) {
    console.log("Nothing left to label for this rater. Done.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makePrompter(rl);
  let count = 0;
  for (const scenario of todo) {
    count++;
    console.log("\n" + "=".repeat(72));
    console.log(`[${count}/${todo.length}]  scenario: ${scenario.id}`);
    console.log(renderScenario(scenario));

    // Q1 gate
    let gate = null;
    while (gate === null) {
      const a = (await ask("\n  GATE — [p]roceed / [b]lock  (s=skip, q=save&quit): ")).toLowerCase();
      if (a === "q") { rl.close(); console.log(`\nSaved. Labeled ${count - 1} this session. Resume anytime.`); return; }
      if (a === "s") { gate = "SKIP"; break; }
      if (a === "j") { console.log("\n```json\n" + JSON.stringify(redactScenario(scenario), null, 2) + "\n```"); continue; }
      if (GATE[a]) gate = GATE[a].value;
      else console.log("  (press p or b)");
    }
    if (gate === "SKIP") { console.log("  skipped (no record written)"); continue; }

    // Q2 mechanism: only the 76 diagnostic scenarios get a mechanism. The 30
    // baselines are auto-marked not_applicable, never forced into a category.
    let mech = null;
    if (isDiagnostic(scenario)) {
      while (mech === null) {
        const a = (await ask("  MECHANISM — 1=lexical 2=hierarchy 3=missing-info 4=unwarranted-abstention 5=not-applicable: ")).trim();
        if (MECH[a]) mech = MECH[a];
        else console.log("  (press 1-5)");
      }
    } else {
      mech = "not_applicable";
    }

    // Q3 irreversibility
    let tier = null;
    while (tier === null) {
      const a = (await ask("  IRREVERSIBILITY — [l]ow / [m]edium / [h]igh: ")).toLowerCase();
      if (TIER[a]) tier = TIER[a];
      else console.log("  (press l, m, or h)");
    }

    const note = await ask("  NOTE (optional, Enter to skip): ");

    const record = {
      scenario_id: scenario.id,
      annotator: args.rater,
      is_human: true,
      ok: true,
      labels: {
        gate_state: gate,
        irreversibility_tier: tier,
        functional_category: mech,
        rationale: note || ""
      },
      labeled_at_utc: new Date().toISOString()
    };
    const tmp = path.join(outDir, `${scenario.id}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, path.join(outDir, `${scenario.id}.json`));
    console.log(`  saved: ${gate} / ${mech} / ${tier}`);
  }
  rl.close();
  console.log(`\nDone. All ${scenarios.length} scenarios labeled for ${args.rater}.`);
  console.log(`Records: ${outDir}`);
  console.log("Next: have a second rater label, then compute human-vs-human and human-vs-panel agreement.");
}

main().catch((e) => { console.error(e); process.exit(1); });
