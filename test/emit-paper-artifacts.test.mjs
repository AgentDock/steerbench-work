// Tests for the paper-artifact emitter. Runs against the real v2026-05 release
// and checks that every emitted headline number equals the published value,
// that output is deterministic, and that the built-in fabrication gate refuses
// to emit from tampered inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitPaperArtifacts, directionalAggregate, patternTable } from "../scripts/emit-paper-artifacts.mjs";

const runnerRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(runnerRoot, "results", "v2026-05");

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test("emits headline numbers that match the published release", () => {
  const out = tmpDir("paper-artifacts");
  const numbers = emitPaperArtifacts({ resultsDir, outDir: out, release: "v2026-05" });

  assert.equal(numbers.scenario_count, 106);
  assert.equal(numbers.condition_count, 30);
  assert.equal(numbers.trials_per_cell, 5);

  // Directional aggregate, as published on the site and in the plan.
  assert.equal(numbers.directional.over_refusal.count, 471);
  assert.equal(numbers.directional.under_refusal.count, 15);
  assert.equal(numbers.directional.over_refusal.rate_pct, 28.1);
  assert.equal(numbers.directional.under_refusal.rate_pct, 1);
  assert.equal(numbers.directional.raw_ratio, 31.4);
  assert.equal(numbers.directional.rate_ratio, 28.1);

  // Memorization control. Gap is computed from raw fractions, rounded once,
  // which gives 34.6 (the difference of the two rounded numbers would be 34.7).
  assert.equal(numbers.anchor_mirror.anchor_pct, 98.5);
  assert.equal(numbers.anchor_mirror.mirror_pct, 63.8);
  assert.equal(numbers.anchor_mirror.gap_points, 34.6);

  // Primary-rank leader.
  assert.equal(numbers.leader.model, "gemini-3.1-flash-lite");
  assert.equal(numbers.leader.reasoning, "minimal");
  assert.equal(numbers.leader.mean_trial_accuracy, "92.8%");

  // Construction-pattern table covers the full 106.
  const totalRows = numbers.patterns.reduce((s, p) => s + p.rows, 0);
  assert.equal(totalRows, 106);
  const byPattern = Object.fromEntries(numbers.patterns.map((p) => [p.pattern, p.modal_pct]));
  assert.equal(byPattern.public_harm_anchor, 98.5);
  assert.equal(byPattern.detector_conflict, 76.8);
  assert.equal(byPattern.incident_mirror, 63.8);
  assert.equal(byPattern.adversarial_control, 45.6);

  // All five artifacts exist; the LaTeX table has one data row per condition.
  for (const f of ["numbers.json", "leaderboard.tex", "patterns.tex", "directional.dat", "anchor-mirror.dat"]) {
    assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
  }
  const tex = fs.readFileSync(path.join(out, "leaderboard.tex"), "utf8");
  const dataLines = tex.split("\n").filter((l) => l.includes(" & ") && l.endsWith("\\\\") && !l.startsWith("Model"));
  assert.equal(dataLines.length, 30);
  assert.match(dataLines[0], /^gemini-3\.1-flash-lite & minimal & 92\.8/);
  assert.ok(!tex.includes("undefined"), "leaderboard.tex contains 'undefined'");
});

test("output is deterministic across runs", () => {
  const a = tmpDir("paper-artifacts-a");
  const b = tmpDir("paper-artifacts-b");
  emitPaperArtifacts({ resultsDir, outDir: a, release: "v2026-05" });
  emitPaperArtifacts({ resultsDir, outDir: b, release: "v2026-05" });
  for (const f of ["numbers.json", "leaderboard.tex", "patterns.tex", "directional.dat", "anchor-mirror.dat"]) {
    assert.equal(
      fs.readFileSync(path.join(a, f), "utf8"),
      fs.readFileSync(path.join(b, f), "utf8"),
      `${f} differs between runs`
    );
  }
});

test("fabrication gate rejects tampered leaderboard numbers and writes nothing", () => {
  const tampered = tmpDir("tampered-results");
  const lb = JSON.parse(fs.readFileSync(path.join(resultsDir, "leaderboard.json"), "utf8"));
  lb.rows[0].mean_trial_accuracy = "99.9%";
  fs.writeFileSync(path.join(tampered, "leaderboard.json"), JSON.stringify(lb));
  fs.copyFileSync(path.join(resultsDir, "scenarios-detail.json"), path.join(tampered, "scenarios-detail.json"));

  const out = tmpDir("paper-artifacts-tampered");
  assert.throws(
    () => emitPaperArtifacts({ resultsDir: tampered, outDir: out, release: "v2026-05" }),
    /fabrication gate failed/
  );
  assert.ok(!fs.existsSync(path.join(out, "numbers.json")), "gate failure must not write artifacts");
});

test("directional aggregate and pattern table agree with scenario-level recount", () => {
  const detail = JSON.parse(fs.readFileSync(path.join(resultsDir, "scenarios-detail.json"), "utf8"));
  const agg = directionalAggregate(detail.scenarios);
  assert.equal(agg.over + agg.under, 486);
  const patterns = patternTable(detail.scenarios);
  const cells = patterns.reduce((s, p) => s + p.cells, 0);
  assert.equal(cells, 106 * 30);
});
