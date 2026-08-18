// Generate ID_MAP.json: the committed descriptive-id -> opaque-token table.
//
// Tokens are derived by salted hash rather than by position, so the token set
// carries no ordering, family, tier, or label signal. Runtime rendering reads
// only the committed map and fails closed when an entry is absent.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const DEFAULT_OUT = path.join(ROOT, "ID_MAP.json");
const SALT = "steerbench-work-v2-id-map";
const ALLOWED_METADATA_FILES = Object.freeze(["_SCENARIO_PATTERNS.json"]);

const token = (prefix, ...parts) =>
  `${prefix}-${crypto.createHash("sha256").update([SALT, prefix, ...parts].join("|")).digest("hex").slice(0, 10)}`;

/**
 * Build a complete opaque-ID map from a scenario-set directory.
 *
 * @param {string} setDir - Directory containing the frozen scenario JSON.
 * @returns {{version: 1, salt: string, scenarios: Record<string,string>, evidence: Record<string,Record<string,string>>}}
 * @throws Error for unexpected metadata, duplicate IDs, missing IDs, or token collisions.
 */
export function buildIdMap(setDir = DEFAULT_SET) {
  const allFiles = fs.readdirSync(setDir).filter((file) => file.endsWith(".json")).sort();
  const metadataFiles = allFiles.filter((file) => file.startsWith("_"));
  if (JSON.stringify(metadataFiles) !== JSON.stringify(ALLOWED_METADATA_FILES)) {
    throw new Error(`underscore-json allowlist violated: ${JSON.stringify(metadataFiles)}`);
  }

  const files = allFiles.filter((file) => !file.startsWith("_"));
  const scenarios = {};
  const evidence = {};
  const sourceIds = new Set();
  const allTokens = new Set();

  const addToken = (opaqueToken, source) => {
    if (!/^[se]-[0-9a-f]{10}$/.test(opaqueToken)) throw new Error(`invalid opaque token for ${source}: ${opaqueToken}`);
    if (allTokens.has(opaqueToken)) throw new Error(`opaque token collision for ${source}: ${opaqueToken}`);
    allTokens.add(opaqueToken);
  };

  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(setDir, file), "utf8"));
    if (typeof json.id !== "string" || !json.id) throw new Error(`missing id in ${file}`);
    if (sourceIds.has(json.id)) throw new Error(`duplicate scenario id: ${json.id}`);
    sourceIds.add(json.id);

    const scenarioToken = token("s", json.id);
    addToken(scenarioToken, json.id);
    scenarios[json.id] = scenarioToken;

    const perScenario = {};
    const evidenceOwners = new Map();
    for (const [index, item] of (json.evidence || []).entries()) {
      for (const key of [item.legacy_id, item.id, item.evidence_id]) {
        if (typeof key !== "string" || !key) continue;
        const prior = evidenceOwners.get(key);
        if (prior !== undefined && prior !== index) {
          throw new Error(`duplicate evidence join key in ${json.id}: ${key}`);
        }
        if (prior === index) continue;
        evidenceOwners.set(key, index);
        const evidenceToken = token("e", json.id, key);
        addToken(evidenceToken, `${json.id}/${key}`);
        perScenario[key] = evidenceToken;
      }
    }
    if (Object.keys(perScenario).length) evidence[json.id] = perScenario;
  }

  return { version: 1, salt: SALT, scenarios, evidence };
}

/**
 * Write the generated ID map to disk.
 *
 * @param {object} options
 * @param {string} [options.setDir] - Scenario-set directory.
 * @param {string} [options.outFile] - Destination JSON file.
 * @returns {{map: ReturnType<typeof buildIdMap>, bytes: string}} Generated map and exact bytes.
 */
export function writeIdMap({ setDir = DEFAULT_SET, outFile = DEFAULT_OUT } = {}) {
  const map = buildIdMap(setDir);
  const bytes = `${JSON.stringify(map, null, 2)}\n`;
  fs.writeFileSync(outFile, bytes);
  return { map, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { map } = writeIdMap();
  console.log(`wrote ${path.relative(ROOT, DEFAULT_OUT)}: ${Object.keys(map.scenarios).length} scenarios, ${Object.keys(map.evidence).length} scenarios with evidence`);
}
