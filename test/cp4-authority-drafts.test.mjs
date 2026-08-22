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
  "amazon-hiring-mirror-advance-candidate-tier-b-005": "0601b81e81731a7ed7e1d83adc851cadf820321b054c4332af849453623c25b1",
  "apple-card-mirror-credit-extension-tier-b-004": "ac148d114dd2625300af420b7f5ac4d42dd4c227f2bd6882ae4e34b1fd4c8bfe",
  "cloudflare-regex-mirror-dry-run-deploy-tier-b-016": "db775a5bf4edfd3e2a3f823834f3e531d463702ff77a07f781a0fd74c9a92361",
  "crowdstrike-mirror-staged-sensor-update-tier-b-015": "f9e2a59c8f98e2866ea41f9eceaadbf3d42625d1546b6d3a67323a132a5402d2",
  "facebook-bgp-mirror-canaried-config-tier-b-014": "5a8941252fd5558c590a77e3194e2c62dc1fa12a58e9f3c08df416a06c1a5b0d",
  "robodebt-mirror-eligible-notice-tier-b-010": "29b795ae89583ad8f8c3db2d08f59a0c6ab7ffdcb14f07e9ad1777b80437c4c2",
  "tesla-autopilot-mirror-lane-change-tier-b-008": "e11f46f982478ac1850ac6b0af47a397de24af33f076f4cf8a298252ff4c607b"
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
      "signature_envelope"
    ]);
    assert.equal(value.schema_version, "steerbench.cp4_authority_review_draft.v1");
    assert.equal(value.status, "draft/pending");
    assert.equal(value.scenario_id, id);
    assert.equal(value.reference_label_change, null);
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
