import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRAFT_DIR = path.join(ROOT, "integrity-audit/v2-audit/cp4-drafts");
const AUTHORITY_REVIEW_PATH = "integrity-audit/v2-audit/AUTHORITY_REVIEW.md";
const SCENARIO_PREFIX = "scenario-sets/steerbench-work-2026-05/";

const AUTHORITY_IDS = [
  "amazon-hiring-mirror-advance-candidate-tier-b-005",
  "apple-card-mirror-credit-extension-tier-b-004",
  "cloudflare-regex-mirror-dry-run-deploy-tier-b-016",
  "crowdstrike-mirror-staged-sensor-update-tier-b-015",
  "facebook-bgp-mirror-canaried-config-tier-b-014",
  "robodebt-mirror-eligible-notice-tier-b-010",
  "tesla-autopilot-mirror-lane-change-tier-b-008"
];

const DRAFT_SHA256 = {
  "amazon-hiring-mirror-advance-candidate-tier-b-005": "8b8547fec948b729109dfbf905da15377f35077cf2477d22f286caf22d424533",
  "apple-card-mirror-credit-extension-tier-b-004": "3b92f34fb4920029feff9ec7b3a16a58b781fe7d42623dcff46142ae7dbf0c81",
  "cloudflare-regex-mirror-dry-run-deploy-tier-b-016": "106f16c8eefb446c403568ae3f57404f976c051230bd04c41b59ac6c461a08cf",
  "crowdstrike-mirror-staged-sensor-update-tier-b-015": "c266f95761ea931875e3835ce78120359149f692abf978d4d451d0fadd75e2fa",
  "facebook-bgp-mirror-canaried-config-tier-b-014": "00845f51f1fd2a07074acc662fbeca394594c921da63e69108d64dc018caa3e1",
  "robodebt-mirror-eligible-notice-tier-b-010": "c3f9c69de824efad9bdda75e611d5766b84ddc2b86908f812ab46e89d5289f6b",
  "tesla-autopilot-mirror-lane-change-tier-b-008": "349d805e7b648043ae9c604622e3a0149eefe8a0df3604a013bc0d82ec3a8abc"
};

const CORRECTED_GROUNDING = {
  "amazon-hiring-mirror-advance-candidate-tier-b-005": {
    field: "scope",
    locators: ["/context/goal", "/user_request"],
    facts: ["APP-77231", "screening", "phone-interview", "scheduling email"]
  },
  "apple-card-mirror-credit-extension-tier-b-004": {
    field: "scope",
    locators: ["/context/goal", "/user_request"],
    facts: ["$5,000", "$8,000", "C-99172", "issuer-system API", "explainability factor list"]
  },
  "cloudflare-regex-mirror-dry-run-deploy-tier-b-016": {
    field: "target",
    locators: ["/user_request"],
    facts: ["WAF-RULE-9281"]
  },
  "facebook-bgp-mirror-canaried-config-tier-b-014": {
    field: "scope",
    locators: ["/evidence", "/context/goal"],
    facts: ["CR-BGP-2026-05-22-12", "progressive rollout", "LAX", "v412"]
  },
  "robodebt-mirror-eligible-notice-tier-b-010": {
    field: "target",
    locators: ["/user_request", "/decision_point/draft"],
    facts: ["WR-66318", "AUD 2,840", "2026-02-01", "2026-04-30"]
  },
  "tesla-autopilot-mirror-lane-change-tier-b-008": {
    field: "target",
    locators: ["/user_request", "/decision_point/draft"],
    facts: ["lane-change-right", "target lane"]
  }
};

const AUTHORITY_REVIEW_KEYS = [
  "grantor",
  "authorized_actor",
  "authorized_role",
  "exact_action",
  "target",
  "scope",
  "temporal_validity",
  "legal_authority",
  "operational_delegation",
  "safety_clearance",
  "supporting_artifact",
  "conclusion",
  "rationale"
];

const UNKNOWN_FIELDS = [
  "grantor",
  "authorized_actor",
  "authorized_role",
  "temporal_validity",
  "legal_authority",
  "operational_delegation"
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function draftFileFor(id) {
  return path.join(DRAFT_DIR, `authority-${id}.json`);
}

function readDraft(id) {
  const bytes = fs.readFileSync(draftFileFor(id));
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function resolveJsonPointer(value, pointer) {
  assert.match(pointer, /^\//);
  return pointer.slice(1).split("/").reduce((current, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.notEqual(current, undefined, `pointer ${pointer} must resolve`);
    return current[key];
  }, value);
}

function resolveConfinedRegularFile(artifact) {
  assert.equal(path.isAbsolute(artifact), false, `${artifact} must be relative`);
  const absolutePath = path.resolve(ROOT, artifact);
  const relativePath = path.relative(fs.realpathSync(ROOT), fs.realpathSync(absolutePath));
  assert.ok(relativePath.length > 0, `${artifact} must resolve below the repository root`);
  assert.equal(relativePath.startsWith(`..${path.sep}`), false, `${artifact} escapes the repository root`);
  assert.notEqual(relativePath, "..", `${artifact} escapes the repository root`);
  assert.equal(fs.lstatSync(absolutePath).isFile(), true, `${artifact} must be a regular file`);
  return absolutePath;
}

test("CP4 authority drafts cover exactly the seven frozen proceed-mirror rows", () => {
  const filenames = fs.readdirSync(DRAFT_DIR)
    .filter((filename) => filename.startsWith("authority-") && filename.endsWith(".json"))
    .sort();
  assert.deepEqual(
    filenames,
    AUTHORITY_IDS.map((id) => `authority-${id}.json`)
  );

  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "CP4_RECERTIFICATION_SCHEMA.json")));
  assert.deepEqual(
    [...schema["x-steerbench"].authority_record_ids].sort(),
    AUTHORITY_IDS
  );
});

test("CP4 authority drafts are canonical, unsigned, and byte-frozen", () => {
  for (const id of AUTHORITY_IDS) {
    const { bytes, value } = readDraft(id);
    assert.deepEqual(Object.keys(value), [
      "schema_version",
      "status",
      "scenario_id",
      "source_artifacts",
      "authority_review",
      "field_grounding",
      "unresolved_owner_decisions",
      "reference_label_change",
      "owner_id",
      "signature_envelope"
    ]);
    assert.equal(value.schema_version, "steerbench.cp4_authority_review_draft.v1");
    assert.equal(value.status, "draft/pending");
    assert.equal(value.scenario_id, id);
    assert.equal(value.reference_label_change, null);
    assert.equal(value.owner_id, null);
    assert.equal(value.signature_envelope, null);
    assert.equal(bytes.toString("utf8"), `${JSON.stringify(value, null, 2)}\n`);
    assert.equal(sha256(bytes), DRAFT_SHA256[id]);
  }
});

test("every cited local artifact exists as a regular file and matches its raw-byte hash", () => {
  for (const id of AUTHORITY_IDS) {
    const draft = readDraft(id).value;
    assert.equal(draft.source_artifacts.length, 2);
    assert.deepEqual(
      draft.source_artifacts.map((source) => source.artifact),
      [AUTHORITY_REVIEW_PATH, `${SCENARIO_PREFIX}${id}.json`]
    );

    for (const source of draft.source_artifacts) {
      assert.deepEqual(Object.keys(source), ["artifact", "sha256"]);
      const absolutePath = resolveConfinedRegularFile(source.artifact);
      assert.equal(sha256(fs.readFileSync(absolutePath)), source.sha256);
    }

    const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, `${SCENARIO_PREFIX}${id}.json`)));
    assert.equal(scenario.id, id);
    assert.deepEqual(
      draft.authority_review.supporting_artifact,
      draft.source_artifacts[1]
    );
  }
});

test("corrected authority fields are supported by the exact cited authored-row values", () => {
  for (const [id, requirement] of Object.entries(CORRECTED_GROUNDING)) {
    const draft = readDraft(id).value;
    const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, `${SCENARIO_PREFIX}${id}.json`)));
    const sources = draft.field_grounding[requirement.field];
    assert.deepEqual(
      sources.map((source) => source.locator),
      requirement.locators,
      `${id}.${requirement.field} must retain the complete supporting locator set`
    );
    const authoredValues = sources
      .map((source) => resolveJsonPointer(scenario, source.locator))
      .map((value) => typeof value === "string" ? value : JSON.stringify(value))
      .join("\n");
    for (const fact of requirement.facts) {
      assert.ok(
        authoredValues.includes(fact),
        `${id}.${requirement.field} must cite authored value containing ${JSON.stringify(fact)}`
      );
    }
  }

  const cloudflare = readDraft("cloudflare-regex-mirror-dry-run-deploy-tier-b-016").value;
  assert.equal(cloudflare.authority_review.target, "Managed rule WAF-RULE-9281.");
  assert.equal(
    cloudflare.authority_review.rationale,
    "Pending owner decision on whether the passing dry run and queued tasking authorize deployment in a change window."
  );
});

test("populated authority fields resolve to cited authored-row or audit locations", () => {
  const authorityReviewText = fs.readFileSync(path.join(ROOT, AUTHORITY_REVIEW_PATH), "utf8");

  for (const id of AUTHORITY_IDS) {
    const draft = readDraft(id).value;
    const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, `${SCENARIO_PREFIX}${id}.json`)));
    const citedArtifacts = new Set(draft.source_artifacts.map((source) => source.artifact));

    assert.deepEqual(Object.keys(draft.authority_review), AUTHORITY_REVIEW_KEYS);
    assert.deepEqual(
      Object.keys(draft.field_grounding),
      ["exact_action", "target", "scope", "safety_clearance", "rationale"]
    );

    for (const [field, sources] of Object.entries(draft.field_grounding)) {
      assert.notEqual(draft.authority_review[field], null, `${id}.${field} must be populated`);
      assert.ok(sources.length > 0, `${id}.${field} must have grounding`);
      for (const source of sources) {
        assert.deepEqual(Object.keys(source), ["artifact", "locator"]);
        assert.equal(citedArtifacts.has(source.artifact), true);
        if (source.artifact.startsWith(SCENARIO_PREFIX)) {
          assert.notEqual(resolveJsonPointer(scenario, source.locator), undefined);
        } else {
          assert.equal(source.artifact, AUTHORITY_REVIEW_PATH);
          assert.ok(authorityReviewText.includes(`| ${id} |`));
          assert.equal(source.locator, `table row: ${id}`);
        }
      }
    }
  }
});

test("drafts do not promote queued tasking or safety gates into authority", () => {
  for (const id of AUTHORITY_IDS) {
    const draft = readDraft(id).value;
    const review = draft.authority_review;
    for (const field of UNKNOWN_FIELDS) {
      assert.equal(review[field], null, `${id}.${field} must remain unknown`);
    }
    assert.equal(review.conclusion, null);
    assert.match(review.safety_clearance, /(?:do|does) not establish/);
    assert.match(review.rationale, /^Pending owner/);

    assert.deepEqual(
      draft.unresolved_owner_decisions.map((decision) => decision.field),
      [...UNKNOWN_FIELDS, "conclusion"]
    );
    for (const decision of draft.unresolved_owner_decisions) {
      assert.deepEqual(Object.keys(decision), ["field", "status", "question"]);
      assert.equal(
        decision.status,
        decision.field === "conclusion" ? "pending_owner_decision" : "unknown"
      );
      assert.ok(decision.question.endsWith("?"));
    }

    const serialized = JSON.stringify(draft);
    assert.equal(serialized.includes("authority_established"), false);
    assert.equal(serialized.includes("authority_not_established"), false);
  }
});
