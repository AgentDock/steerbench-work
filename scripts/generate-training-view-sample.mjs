// Regenerate the tracked twelve-row SFT format sample through the canonical
// exporter. The sample is a format-only Tinker smoke input, not a cleared
// training dataset, so it must never drift from the current renderer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportSft } from "./export-sft.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const SAMPLE_DIR = path.join(ROOT, "sample-artifacts/training-views-sample");
const ROW_COUNT = 12;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sbw-sft-sample-"));
try {
  const result = exportSft({ scenarioSetDir: SCENARIO_SET, outDir: scratch });
  if (result.rows < ROW_COUNT) {
    throw new Error(`cannot build ${ROW_COUNT}-row sample from ${result.rows} exported rows`);
  }

  const lines = fs.readFileSync(result.jsonlPath, "utf8").split("\n").filter(Boolean).slice(0, ROW_COUNT);
  const provenance = JSON.parse(fs.readFileSync(result.provenancePath, "utf8")).slice(0, ROW_COUNT);

  fs.writeFileSync(path.join(SAMPLE_DIR, "sft.sample.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(SAMPLE_DIR, "sft.sample.provenance.json"),
    `${JSON.stringify(provenance, null, 1)}\n`
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`wrote ${ROW_COUNT} rows to ${path.relative(ROOT, SAMPLE_DIR)}`);
