// Regenerate the human-readable scenario-set MANIFEST.md from the same manifest
// builder used by the runner. This avoids hand-maintained taxonomy/count drift.
import fs from "node:fs";
import path from "node:path";
import { buildScenarioManifest } from "../src/manifest.mjs";

const scenarioSet = "steerbench-work-2026-05";
const scenarioSetDir = path.join("scenario-sets", scenarioSet);
const outPath = path.join(scenarioSetDir, "MANIFEST.md");
const patternPath = path.join(scenarioSetDir, "_SCENARIO_PATTERNS.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .trim();
}

function firstUrl(text) {
  const m = String(text || "").match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[).,;]+$/, "") : "";
}

function inferBoundaryPattern({ entry, file }) {
  const tags = new Set([...(entry.tags || []), ...(file.tags || [])]);

  if (entry.source_provenance === "incident-mirror" || [...tags].some((t) => /mirror/i.test(t))) {
    return "incident_mirror";
  }
  if (tags.has("adversarial")) return "adversarial_control";
  if (tags.has("false_positive_flag")) return "detector_conflict";
  if (tags.has("safe_control")) return "clean_control";
  if (
    entry.source_provenance === "real-world-cited" ||
    entry.source_provenance === "literature + analogous incident"
  ) return "public_harm_anchor";
  if (entry.source_provenance == null) return "calibration_control";
  return "unassigned";
}

function sourceProvenanceLabel(entry) {
  return entry.source_provenance || "not_applicable_calibration";
}

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function tableFromCounts(title, map) {
  const rows = [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return [
    `## ${title}`,
    "",
    "| Value | Count |",
    "|---|---:|",
    ...rows.map(([k, v]) => `| ${esc(k || "not_applicable")} | ${v} |`),
    "",
  ].join("\n");
}

const manifest = buildScenarioManifest({
  scenarioSet,
  scenarioSetDir,
});
const patterns = fs.existsSync(patternPath) ? readJson(patternPath).scenarios || {} : {};

const directionCounts = new Map();
const categoryCounts = new Map();
const domainCounts = new Map();
const actionCounts = new Map();
const provenanceCounts = new Map();
const patternCounts = new Map();

const rows = [];
for (const entry of manifest.scenarios) {
  const json = readJson(path.join(scenarioSetDir, entry.file));
  const pattern = patterns[entry.id]?.boundary_pattern || inferBoundaryPattern({ entry, file: json });
  inc(directionCounts, entry.direction || "baseline");
  inc(categoryCounts, entry.functional_category || "not_applicable");
  inc(domainCounts, entry.domain || "unknown");
  inc(actionCounts, entry.action_verb || "unknown");
  inc(provenanceCounts, sourceProvenanceLabel(entry));
  inc(patternCounts, pattern);
  rows.push({
    id: entry.id,
    expected: entry.expected_action,
    direction: entry.direction || "baseline",
    category: entry.functional_category || "not_applicable",
    domain: entry.domain,
    action: entry.action_verb,
    irreversibility: entry.irreversibility_class,
    provenance: sourceProvenanceLabel(entry),
    pattern,
    source: json.source_incident_url || firstUrl(json.source_basis) || "(synthetic / author-constructed)",
    title: json.title || entry.id,
  });
}

const body = [
  "# Scenario Set Manifest",
  "",
  `**Release:** v2026-05.`,
  `**Total:** ${manifest.scenario_count} scenarios. 76 sourced/adversarial diagnostic scenarios and 30 calibration baselines.`,
  "",
  "> This file is generated from the scenario JSON and the runner manifest builder. The run-root `SCENARIO_MANIFEST.json` remains the scoring authority for a frozen run; this Markdown file is the readable release inventory.",
  "",
  `**Last generated:** ${new Date().toISOString().slice(0, 10)}.`,
  "",
  tableFromCounts("Direction counts", directionCounts),
  tableFromCounts("Functional category counts", categoryCounts),
  tableFromCounts("Domain counts", domainCounts),
  tableFromCounts("Action-effect counts", actionCounts),
  tableFromCounts("Source-provenance counts", provenanceCounts),
  tableFromCounts("Boundary-pattern counts", patternCounts),
  "## Notes",
  "",
  "- `functional_category` is not applicable to the 30 calibration baselines.",
  "- `boundary_pattern` is scenario-construction metadata used for slicing and review navigation; it is not the scored label.",
  "- The scored action-boundary label is `expected_action`, mapped by the runner to `commit_permission = allowed` or `blocked`.",
  "- Domains are the canonical runner domains used by published artifacts.",
  "",
  "## All scenarios",
  "",
  "| ID | Expected action | Direction | Functional category | Domain | Action effect | Irreversibility | Provenance | Boundary pattern | Source | Title |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${esc(r.id)} | ${esc(r.expected)} | ${esc(r.direction)} | ${esc(r.category)} | ${esc(r.domain)} | ${esc(r.action)} | ${esc(r.irreversibility)} | ${esc(r.provenance)} | ${esc(r.pattern)} | ${esc(r.source)} | ${esc(r.title)} |`),
  "",
].join("\n");

fs.writeFileSync(outPath, body);
console.log(`wrote ${outPath} (${manifest.scenario_count} scenarios)`);
