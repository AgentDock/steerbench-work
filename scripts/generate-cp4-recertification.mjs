#!/usr/bin/env node
// Generate the unsigned CP4 owner-recertification template. The generator is
// deliberately offline: it serializes only the frozen cohort shells exposed
// by src/cp4-recertification.mjs and never fills review facts or signatures.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeCp4Recertification,
  createPendingCp4Recertification
} from "../src/cp4-recertification.mjs";

function parseArguments(argv) {
  let outPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--out") {
      throw new Error(`unknown argument ${argument}`);
    }
    if (outPath !== null) throw new Error("duplicate argument --out");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--out requires a value");
    }
    outPath = value;
  }
  if (outPath === null) throw new Error("--out <file> is required");
  return { outPath: path.resolve(outPath) };
}

/**
 * Build the canonical unsigned CP4 recertification artifact bytes.
 *
 * @returns {{artifact: object, bytes: string}} Pending artifact and canonical bytes.
 */
export function generateCp4RecertificationArtifact() {
  const artifact = createPendingCp4Recertification();
  const bytes = `${canonicalizeCp4Recertification(artifact)}\n`;
  return { artifact, bytes };
}

/**
 * Write the canonical unsigned CP4 recertification artifact.
 *
 * @param {string} outPath Explicit destination path.
 * @returns {{artifact: object, bytes: string, outPath: string}} Written artifact details.
 */
export function writeCp4RecertificationArtifact(outPath) {
  if (typeof outPath !== "string" || outPath.length === 0) {
    throw new Error("outPath must be a non-empty string");
  }
  const resolvedOutPath = path.resolve(outPath);
  const { artifact, bytes } = generateCp4RecertificationArtifact();
  fs.writeFileSync(resolvedOutPath, bytes);
  return { artifact, bytes, outPath: resolvedOutPath };
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outPath } = parseArguments(process.argv.slice(2));
    const { artifact } = writeCp4RecertificationArtifact(outPath);
    process.stdout.write(
      `wrote ${outPath}: ${artifact.scenario_count} pending CP4 records\n`
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
