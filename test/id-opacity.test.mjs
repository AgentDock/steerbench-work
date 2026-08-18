// Regression tests for VALIDATION_PLAN.md instrument fixes 1-2: detector
// decoupling from author-only fields and identifiers, and identifier opacity
// in every model-visible byte.
//
// The five tests the plan requires are t3-t7 below; t1-t2 cover the
// decoupling half.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { renderUserMessage } from "../src/model-input.mjs";
import { buildModelInputFor, reshapeToLegacy } from "../src/canonical-runner.mjs";
import { opaqueIdResolversForMap } from "../src/id-map.mjs";
import { buildIdMap } from "../scripts/generate-id-map.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, "ID_MAP.json"), "utf8"));

const load = (id) => JSON.parse(fs.readFileSync(path.join(SET, `${id}.json`), "utf8"));
const SUBJECT = "robodebt-mirror-eligible-notice-tier-b-010";
const TRAP_SUBJECT = "samsung-chatgpt-source-code-paste-high-impact-013";

const render = async (json, candidateMap) => {
  const resolvers = candidateMap ? opaqueIdResolversForMap(candidateMap) : {};
  const rendered = buildModelInputFor(reshapeToLegacy(json), resolvers);
  return {
    ...rendered,
    model_input: renderUserMessage({
      scenarioId: json.id,
      modelInput: rendered.model_input,
      scenarioIdFor: resolvers.scenarioIdFor
    })
  };
};

const tmpScenarioSet = (entries) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbw-idmap-set-"));
  fs.writeFileSync(path.join(dir, "_SCENARIO_PATTERNS.json"), "{}\n");
  for (const [name, value] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  return dir;
};

test("t1 mutating an author-only hidden_trap changes no model-visible byte", async () => {
  const base = await render(load(TRAP_SUBJECT));
  const mutated = structuredClone(load(TRAP_SUBJECT));
  if (mutated.context) mutated.context.hidden_trap = "COMPLETELY DIFFERENT AUTHOR NOTE";
  mutated.hidden_trap = "COMPLETELY DIFFERENT AUTHOR NOTE";
  const after = await render(mutated);
  assert.equal(after.model_input, base.model_input);
  assert.deepEqual(after.integrity_flags.sort(), base.integrity_flags.sort());
});

test("t2 mutating expected_behavior changes no model-visible byte", async () => {
  const base = await render(load(SUBJECT));
  const mutated = structuredClone(load(SUBJECT));
  mutated.expected_behavior = {
    ...(mutated.expected_behavior || {}),
    correct_action: mutated.expected_behavior?.correct_action === "continue" ? "escalate" : "continue"
  };
  const after = await render(mutated);
  assert.equal(after.model_input, base.model_input);
  assert.deepEqual(after.integrity_flags.sort(), base.integrity_flags.sort());
});

test("t2b mutating answer-key expected_evidence changes no model-visible byte", async () => {
  const base = await render(load(SUBJECT));
  const mutated = structuredClone(load(SUBJECT));
  mutated.expected_evidence = [];
  const after = await render(mutated);
  assert.equal(after.model_input, base.model_input);
  assert.deepEqual(after.integrity_flags.sort(), base.integrity_flags.sort());
});

test("t3 derived surfaces are invariant under a source-id change", async () => {
  const base = await render(load(SUBJECT));
  const renamed = structuredClone(load(SUBJECT));
  renamed.id = "totally-different-source-id-001";
  const map = structuredClone(MAP);
  map.scenarios[renamed.id] = MAP.scenarios[SUBJECT];
  map.evidence[renamed.id] = MAP.evidence[SUBJECT];
  delete map.scenarios[SUBJECT];
  delete map.evidence[SUBJECT];
  const after = await render(renamed, map);
  assert.deepEqual(after.integrity_flags.sort(), base.integrity_flags.sort());
});

test("t4 no descriptive source id appears in any rendered byte", async () => {
  const files = fs.readdirSync(SET).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  assert.equal(files.length, 106);
  for (const f of files) {
    const json = JSON.parse(fs.readFileSync(path.join(SET, f), "utf8"));
    const input = (await render(json)).model_input;
    assert.ok(!input.includes(json.id), `scenario id leaked in ${json.id}`);
    for (const item of json.evidence || []) {
      for (const key of [item.legacy_id, item.id].filter((k) => typeof k === "string" && k.length > 3)) {
        assert.ok(!input.includes(key), `evidence id ${key} leaked in ${json.id}`);
      }
      if (typeof item.raw_ref === "string" && item.raw_ref) {
        assert.ok(!input.includes(item.raw_ref), `evidence path ${item.raw_ref} leaked in ${json.id}`);
      }
    }
  }
});

test("t5 renaming the source id and its map key, same token, leaves bytes identical", async () => {
  const base = await render(load(SUBJECT));
  const renamed = structuredClone(load(SUBJECT));
  renamed.id = "renamed-source-id-002";
  for (const item of renamed.evidence || []) {
    if (item.legacy_id) item.legacy_id = `renamed-${item.legacy_id}`;
    if (item.id) item.id = `renamed-${item.id}`;
  }
  if (Array.isArray(renamed.decision_point?.evidence_ids)) {
    renamed.decision_point.evidence_ids = renamed.decision_point.evidence_ids.map((e) => `renamed-${e}`);
  }
  const map = structuredClone(MAP);
  map.scenarios[renamed.id] = MAP.scenarios[SUBJECT];
  map.evidence[renamed.id] = Object.fromEntries(
    Object.entries(MAP.evidence[SUBJECT] || {}).map(([k, v]) => [`renamed-${k}`, v])
  );
  delete map.scenarios[SUBJECT];
  delete map.evidence[SUBJECT];
  const after = await render(renamed, map);
  assert.equal(after.model_input, base.model_input);
});

test("t6 changing the opaque token changes only that token", async () => {
  const base = await render(load(SUBJECT));
  const oldToken = MAP.scenarios[SUBJECT];
  const newToken = "s-ffffffffff";
  const map = structuredClone(MAP);
  map.scenarios[SUBJECT] = newToken;
  const after = await render(load(SUBJECT), map);
  assert.ok(base.model_input.includes(oldToken), "the baseline wire message must contain the mapped scenario token");
  assert.ok(after.model_input.includes(newToken), "the substituted wire message must contain the new scenario token");
  assert.equal(after.model_input.split(newToken).join(oldToken), base.model_input);
});

test("t7 an unmapped identifier fails closed", async () => {
  const map = structuredClone(MAP);
  delete map.scenarios[SUBJECT];
  delete map.evidence[SUBJECT];
  await assert.rejects(
    () => render(load(SUBJECT), map),
    /absent from the opaque id map/,
    "a frozen run must not derive an unreviewed fallback token"
  );
});

test("t8 opaque tokens and synthesized filenames carry no semantic or label prefix", async () => {
  const files = fs.readdirSync(SET).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  const seenScenarioPrefixes = new Set();
  const sidesByPrefix = new Map();

  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(SET, file), "utf8"));
    const input = (await render(json, MAP)).model_input;
    const token = MAP.scenarios[json.id];
    assert.match(token, /^s-[0-9a-f]{10}$/);
    assert.ok(input.startsWith(`scenario_ref: ${token}\n\n`));
    assert.ok(!input.includes(json.id));

    const prefix = token.split("-")[0];
    seenScenarioPrefixes.add(prefix);
    const side = json.expected_behavior?.correct_action === "continue" ? "proceed" : "hold";
    if (!sidesByPrefix.has(prefix)) sidesByPrefix.set(prefix, new Set());
    sidesByPrefix.get(prefix).add(side);

    for (const item of json.evidence || []) {
      const key = item.legacy_id || item.id;
      const evidenceToken = MAP.evidence[json.id][key];
      assert.match(evidenceToken, /^e-[0-9a-f]{10}$/);
      assert.ok(input.includes(evidenceToken), `${json.id} must render the mapped evidence token`);
    }

    for (const match of input.matchAll(/(?:outbox|reports|finance|tool-calls)\/(s-[0-9a-f]{10})\.[a-z.]+/g)) {
      assert.equal(match[1], token, `${json.id} synthesized filename must use only its opaque token`);
    }
  }

  assert.deepEqual([...seenScenarioPrefixes], ["s"]);
  assert.deepEqual([...sidesByPrefix.get("s")].sort(), ["hold", "proceed"]);
});

test("t9 mutating authored evidence paths and titles changes no derived byte or flag", async () => {
  const files = fs.readdirSync(SET).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(SET, file), "utf8"));
    const base = await render(json);
    const mutated = structuredClone(json);
    for (const [index, item] of (mutated.evidence || []).entries()) {
      item.raw_ref = `neutral/reference-${index + 1}.dat`;
      item.title = `Neutral evidence ${index + 1}`;
    }
    const after = await render(mutated);
    assert.equal(after.model_input, base.model_input, `${json.id} path/title mutation changed the wire message`);
    assert.deepEqual(after.integrity_flags.sort(), base.integrity_flags.sort(), `${json.id} path/title mutation changed flags`);
  }
});

test("t9b explicit runtime file paths are replaced by opaque non-semantic references", async () => {
  const raw = load(SUBJECT);
  const scenario = reshapeToLegacy(raw);
  scenario.integrity_evidence = {
    touched_files: [{
      path: "evals/secret-answer-key.json",
      change_type: "edit",
      surface: "evaluation",
      protected: true,
      reason: "runtime supplied protected evaluation surface",
      status: "current"
    }]
  };

  const first = buildModelInputFor(scenario);
  const mutated = structuredClone(scenario);
  mutated.integrity_evidence.touched_files[0].path = "reports/customer-score.csv";
  const second = buildModelInputFor(mutated);

  assert.equal(second.model_input, first.model_input);
  assert.deepEqual(second.integrity_flags.sort(), first.integrity_flags.sort());
  assert.ok(!first.model_input.includes("secret-answer-key"));
  assert.ok(!first.model_input.includes("customer-score"));
  assert.match(first.model_input, /evaluation:s-[0-9a-f]{10}\/touch-001\.ref:protected/);

  const missingSurface = structuredClone(scenario);
  delete missingSurface.integrity_evidence.touched_files[0].surface;
  assert.throws(
    () => buildModelInputFor(missingSurface),
    /missing an explicit surface/,
    "runtime paths must not be reclassified from semantic filenames"
  );

  const semanticSurface = structuredClone(scenario);
  semanticSurface.integrity_evidence.touched_files[0].surface = "private/answer-key.json";
  assert.throws(
    () => buildModelInputFor(semanticSurface),
    /invalid surface/,
    "a runtime adapter must not smuggle a semantic path through the surface field"
  );

  const heldoutSurface = structuredClone(scenario);
  heldoutSurface.integrity_evidence.touched_files[0].surface = "heldout_evaluation_data";
  heldoutSurface.integrity_evidence.touched_files[0].protected = false;
  const heldout = buildModelInputFor(heldoutSurface);
  assert.ok(heldout.integrity_flags.includes("hidden_eval_data_access"));
  assert.ok(heldout.integrity_flags.includes("protected_surface_change"));
  assert.match(heldout.model_input,
    /heldout_evaluation_data:s-[0-9a-f]{10}\/touch-001\.ref:protected/);
});

test("t9c explicit runtime reads survive reshape, stay opaque, and fail closed", async () => {
  const raw = load(SUBJECT);
  raw.integrity_evidence = {
    read_files: [{
      path: "evals/private-heldout-answer-key.json",
      surface: "heldout_evaluation_data",
      protected: false,
      reason: "runtime supplied a held-out evaluation read",
      status: "current"
    }]
  };

  const first = buildModelInputFor(reshapeToLegacy(raw));
  const changedPath = structuredClone(raw);
  changedPath.integrity_evidence.read_files[0].path = "another/private-score-key.csv";
  const second = buildModelInputFor(reshapeToLegacy(changedPath));

  assert.equal(second.model_input, first.model_input);
  assert.deepEqual(second.integrity_flags.sort(), first.integrity_flags.sort());
  assert.ok(!first.model_input.includes("private-heldout-answer-key"));
  assert.ok(!first.model_input.includes("private-score-key"));
  assert.match(first.model_input,
    /heldout_evaluation_data:s-[0-9a-f]{10}\/read-001\.ref:protected/);
  assert.ok(first.integrity_flags.includes("hidden_eval_data_access"));

  const missingSurface = structuredClone(raw);
  delete missingSurface.integrity_evidence.read_files[0].surface;
  assert.throws(
    () => buildModelInputFor(reshapeToLegacy(missingSurface)),
    /missing an explicit surface/,
    "runtime reads without a surface must fail closed"
  );

  const invalidSurface = structuredClone(raw);
  invalidSurface.integrity_evidence.read_files[0].surface = "private/answer-key.json";
  assert.throws(
    () => buildModelInputFor(reshapeToLegacy(invalidSurface)),
    /invalid surface/,
    "runtime reads must not smuggle a semantic path through the surface field"
  );

  const malformedList = structuredClone(raw);
  malformedList.integrity_evidence.read_files = null;
  assert.throws(
    () => buildModelInputFor(reshapeToLegacy(malformedList)),
    /read_files must be an array/,
    "an explicit malformed runtime read list must not fall back to authored evidence"
  );

  const explicitNoReads = structuredClone(raw);
  explicitNoReads.integrity_evidence.read_files = [];
  const noReads = buildModelInputFor(reshapeToLegacy(explicitNoReads));
  assert.match(
    noReads.model_input,
    /integrity_read_files: none/,
    "an explicit empty runtime read list must override evidence-derived fallback reads"
  );
});

test("t10 malformed or duplicate tokens in an alternate map fail closed", async () => {
  const malformed = structuredClone(MAP);
  malformed.scenarios[SUBJECT] = "robodebt-is-safe";
  await assert.rejects(() => render(load(SUBJECT), malformed), /invalid scenario token/);

  const duplicate = structuredClone(MAP);
  duplicate.scenarios[SUBJECT] = duplicate.scenarios[TRAP_SUBJECT];
  await assert.rejects(() => render(load(SUBJECT), duplicate), /duplicate tokens/);
});

test("t11 ID-map generation rejects unexpected metadata and duplicate join keys", () => {
  const subject = load(SUBJECT);
  const unexpected = tmpScenarioSet({ [`${subject.id}.json`]: subject, "_bad.json": {} });
  assert.throws(() => buildIdMap(unexpected), /underscore-json allowlist violated/);

  const duplicateId = tmpScenarioSet({
    "first.json": subject,
    "second.json": structuredClone(subject)
  });
  assert.throws(() => buildIdMap(duplicateId), /duplicate scenario id/);

  const duplicateEvidence = structuredClone(subject);
  duplicateEvidence.evidence = [
    { id: "E01", legacy_id: "shared", source_type: "document" },
    { id: "E02", legacy_id: "shared", source_type: "document" }
  ];
  const duplicateKey = tmpScenarioSet({ [`${subject.id}.json`]: duplicateEvidence });
  assert.throws(() => buildIdMap(duplicateKey), /duplicate evidence join key/);
});
