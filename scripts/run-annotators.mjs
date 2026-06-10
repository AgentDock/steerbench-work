#!/usr/bin/env node
/**
 * @fileoverview Three-vendor annotation panel runner, task-split path.
 * @module scripts/run-annotators
 *
 * Two prompt passes per the task split (see src/annotator-panel.mjs):
 *   - scenario-label: right_call + irreversibility_tier, from operational
 *     evidence only (no model output). Runs on ALL scenarios.
 *   - mechanism: functional_category, from operational evidence PLUS the
 *     observed refusal. Runs on the DIAGNOSTIC subset only.
 *
 * Prompts are built by the allowlisted builders; the scenario id never enters a
 * prompt. Each output record is written to
 *   runs/annotator-panel/<root>/<vendor>/<prompt_type>/<scenario_id>.json
 * and carries prompt_type + prompt_sha256 so the scorer can join the two passes.
 *
 * Resumable: a cell is skipped only if it already succeeded (ok:true); a prior
 * failure is retried. --resume <root> writes back into an existing run instead
 * of minting a fresh root, so a retry only fills failed/missing cells.
 *
 * Usage:
 *   node scripts/run-annotators.mjs --dry
 *   node scripts/run-annotators.mjs --limit 1            (smoke: 1 scenario)
 *   node scripts/run-annotators.mjs                       (full panel)
 *   node scripts/run-annotators.mjs --resume <root>       (retry failed cells)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildScenarioLabelSystemPrompt,
  buildScenarioLabelUserPrompt,
  parseScenarioLabel,
  buildMechanismSystemPrompt,
  buildMechanismUserPrompt,
  parseMechanism
} from "../src/annotator-panel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.join(__dirname, "..");
const SCENARIO_DIR = path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05");
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

// The three annotators. max_tokens is deliberately generous: these are reasoning
// models that spend hidden reasoning tokens before emitting the JSON, so a tight
// cap returns empty/truncated text. The values below give room to reason AND
// emit the small label object for all three.
const ANNOTATORS = Object.freeze([
  { key: "gpt-5.5", slug: "openai/gpt-5.5", max_tokens: 4000 },
  { key: "claude-opus-4.8", slug: "anthropic/claude-opus-4.8", max_tokens: 2000 },
  { key: "gemini-3.1-pro", slug: "google/gemini-3.1-pro-preview", max_tokens: 4000 }
]);

const MAX_RETRIES = 3;

/**
 * Parse CLI args.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = { limit: null, scenario: null, vendor: null, dry: false, resume: null, scenariosFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") args.dry = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--scenario") args.scenario = argv[++i];
    else if (a === "--vendor") args.vendor = argv[++i];
    else if (a === "--resume") args.resume = argv[++i];
    else if (a === "--scenarios-file") args.scenariosFile = argv[++i];
  }
  return args;
}

/**
 * Resolve the gateway key from env or the runner .env.
 *
 * @returns {string|null}
 */
function loadKey() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  const envPath = path.join(runnerRoot, ".env");
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("AI_GATEWAY_API_KEY="));
    if (line) return line.slice("AI_GATEWAY_API_KEY=".length).trim();
  }
  return null;
}

/** @returns {string[]} sorted scenario filenames */
function listScenarioFiles() {
  return fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).sort();
}

/**
 * The 76 diagnostic scenarios carry a taxonomy block; the 30 calibration
 * controls do not. The mechanism pass runs only on diagnostic scenarios.
 *
 * @param {object} scenario
 * @returns {boolean}
 */
function isDiagnostic(scenario) {
  return Boolean(scenario && scenario.taxonomy && typeof scenario.taxonomy === "object");
}

/**
 * One gateway annotation call with retry on transient/parse failure. The parser
 * is supplied by the caller so each pass validates only its own labels.
 *
 * @param {object} a
 * @param {string} a.key
 * @param {object} a.annotator
 * @param {string} a.system
 * @param {string} a.user
 * @param {(raw: string) => {ok: boolean, labels: object|null, error: string|null}} a.parse
 * @returns {Promise<object>}
 */
async function annotateOnce({ key, annotator, system, user, parse }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let resp, text;
    try {
      resp = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: annotator.slug,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          max_tokens: annotator.max_tokens
        })
      });
      text = await resp.text();
    } catch (e) {
      lastErr = `network error: ${e.message}`;
      continue;
    }
    if (!resp.ok) {
      lastErr = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      lastErr = `response not JSON: ${e.message}`;
      continue;
    }
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parse(content);
    if (parsed.ok) {
      return { ok: true, labels: parsed.labels, error: null, http_status: resp.status, raw: content, usage: json.usage ?? null };
    }
    lastErr = `label parse failed: ${parsed.error} | raw: ${content.slice(0, 160)}`;
  }
  return { ok: false, labels: null, error: lastErr, http_status: null, raw: null, usage: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = loadKey();
  if (!key && !args.dry) {
    console.error("No AI_GATEWAY_API_KEY (env or .env). Cannot run. Use --dry to preview.");
    process.exit(1);
  }

  let files = listScenarioFiles();
  if (args.scenario) files = files.filter((f) => f === args.scenario || f === args.scenario + ".json" || f.startsWith(args.scenario));
  if (args.scenariosFile) {
    const raw = JSON.parse(fs.readFileSync(args.scenariosFile, "utf8"));
    const ids = new Set(raw.map((r) => (typeof r === "string" ? r : r.id)));
    files = files.filter((f) => ids.has(f.replace(/\.json$/, "")));
  }
  if (args.limit != null) files = files.slice(0, args.limit);

  const annotators = args.vendor ? ANNOTATORS.filter((a) => a.key === args.vendor) : ANNOTATORS;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = args.resume
    ? (path.isAbsolute(args.resume) ? args.resume : path.join(runnerRoot, args.resume))
    : path.join(runnerRoot, "runs", "annotator-panel", args.dry ? `dry-${stamp}` : stamp);
  if (args.resume && !fs.existsSync(outRoot)) {
    console.error(`--resume root does not exist: ${outRoot}`);
    process.exit(1);
  }

  // Task split: two prompt passes. scenario-label on all scenarios; mechanism on
  // the diagnostic subset. Each carries its own system prompt, user builder, and
  // parser.
  const PASSES = [
    { type: "scenario-label", system: buildScenarioLabelSystemPrompt(), buildUser: buildScenarioLabelUserPrompt, parse: parseScenarioLabel, applies: () => true },
    { type: "mechanism", system: buildMechanismSystemPrompt(), buildUser: buildMechanismUserPrompt, parse: parseMechanism, applies: isDiagnostic }
  ];

  const scenarios = files.map((file) => ({ file, scenario: JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, file), "utf8")) }));
  let estCalls = 0;
  for (const { scenario } of scenarios) for (const p of PASSES) if (p.applies(scenario)) estCalls += annotators.length;

  console.log("Annotation panel run (task-split, allowlisted prompts)");
  console.log(`  scenarios: ${files.length}  vendors: ${annotators.map((a) => a.key).join(", ")}`);
  console.log(`  passes: scenario-label (all) + mechanism (diagnostic only)`);
  console.log(`  mode: ${args.dry ? "DRY (no API calls)" : "LIVE"}  out: ${path.relative(runnerRoot, outRoot)}`);
  console.log(`  estimated calls: ${estCalls}`);

  let calls = 0, ok = 0, failed = 0, totalCost = 0;

  for (const { file, scenario } of scenarios) {
    const scenarioId = scenario.id || file.replace(/\.json$/, "");
    for (const pass of PASSES) {
      if (!pass.applies(scenario)) continue;
      const user = pass.buildUser(scenario);
      const promptSha = crypto.createHash("sha256").update(pass.system + "\n\n" + user).digest("hex");

      if (args.dry) {
        if (file === files[0]) {
          console.log(`\n--- [dry] ${pass.type} user prompt for ${scenarioId} (first 400 chars) ---`);
          console.log(user.slice(0, 400));
        }
        continue;
      }

      for (const annotator of annotators) {
        const outDir = path.join(outRoot, annotator.key, pass.type);
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `${scenarioId}.json`);
        if (fs.existsSync(outFile)) {
          try { if (JSON.parse(fs.readFileSync(outFile, "utf8")).ok === true) continue; } catch { /* re-annotate */ }
        }

        calls++;
        const result = await annotateOnce({ key, annotator, system: pass.system, user, parse: pass.parse });
        const record = {
          scenario_id: scenarioId,
          annotator: annotator.key,
          model_slug: annotator.slug,
          prompt_type: pass.type,
          prompt_sha256: promptSha,
          is_diagnostic: isDiagnostic(scenario),
          ok: result.ok,
          labels: result.labels,
          error: result.error,
          http_status: result.http_status,
          usage: result.usage,
          annotated_at_utc: new Date().toISOString()
        };
        const tmp = outFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
        fs.renameSync(tmp, outFile);

        if (result.ok) {
          ok++;
          if (result.usage?.cost) totalCost += result.usage.cost;
          const summary = pass.type === "scenario-label"
            ? `${result.labels.gate_state}/${result.labels.irreversibility_tier}`
            : result.labels.functional_category;
          console.log(`  [ok] ${annotator.key} ${pass.type} ${scenarioId} -> ${summary}`);
        } else {
          failed++;
          console.log(`  [FAIL] ${annotator.key} ${pass.type} ${scenarioId}: ${result.error}`);
        }
      }
    }
  }

  if (!args.dry) {
    fs.writeFileSync(
      path.join(outRoot, "run-summary.json"),
      JSON.stringify({ scenarios: files.length, vendors: annotators.map((a) => a.key), passes: PASSES.map((p) => p.type), calls, ok, failed, total_cost_usd: totalCost, finished_at_utc: new Date().toISOString() }, null, 2)
    );
    console.log(`\nDone. calls=${calls} ok=${ok} failed=${failed} cost=$${totalCost.toFixed(4)}`);
    console.log(`Output: ${path.relative(runnerRoot, outRoot)}`);
  } else {
    console.log(`\nDry run complete. Estimated ${estCalls} calls (scenario-label all + mechanism diagnostic, x ${annotators.length} vendors).`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
