/**
 * @fileoverview Glossary data + term matching for the human validation labeler.
 * @module src/glossary
 *
 * The term definitions are DATA, not code: they live in
 * docs/annotation/glossary.json (grouped, versioned next to the annotation
 * guidelines) and are loaded at boot. This module also does the per-card term
 * matching server-side, so the browser page renders a precomputed list and runs
 * no matching logic of its own.
 *
 * Matching follows the mark.js approach: one combined alternation regex with all
 * terms sorted longest-first (the eager engine then prefers the longer term, so
 * "credit utilization" wins over "credit"), Unicode-aware lookaround boundaries
 * so a term never matches inside a larger word, a single pass, and each term
 * surfaced only on its first occurrence.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GLOSSARY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "annotation",
  "glossary.json"
);

/**
 * Reads the grouped glossary from disk.
 *
 * @param {string} [file] - Path to glossary.json (defaults to the packaged one)
 * @returns {Array<{group: string, terms: Record<string, string>}>}
 */
export function loadGlossaryGroups(file = DEFAULT_GLOSSARY_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Builds the lookup + matcher index from glossary groups.
 *
 * @param {Array<{group: string, terms: Record<string, string>}>} groups
 * @returns {{ map: Record<string,string>, lower: Record<string,string>, regex: RegExp|null }}
 *   map: term -> definition; lower: lowercased term -> canonical term;
 *   regex: combined longest-first matcher (null if the glossary is empty).
 */
export function buildGlossaryIndex(groups) {
  const map = {};
  for (const g of groups || []) {
    for (const [term, def] of Object.entries(g.terms || {})) map[term] = def;
  }
  // Drop empty/whitespace-only keys: an empty alternation branch would make the
  // matcher regex match zero-width and never advance (a hang on bad data).
  const keys = Object.keys(map).filter((k) => k.trim().length > 0);
  const lower = {};
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lower[lk] && lower[lk] !== k) {
      console.warn(`[glossary] "${k}" and "${lower[lk]}" differ only by case; the matcher cannot tell them apart.`);
    }
    lower[lk] = k;
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sorted = keys.slice().sort((a, b) => b.length - a.length);
  const regex = keys.length
    ? new RegExp(
        "(?<![\\p{L}\\p{N}_-])(" + sorted.map(escapeRe).join("|") + ")(?![\\p{L}\\p{N}_-])",
        "giu"
      )
    : null;
  return { map, lower, regex };
}

/**
 * Returns the canonical glossary terms that appear in a block of text, each at
 * most once, in order of first appearance, longest-match-wins.
 *
 * @param {string} text
 * @param {ReturnType<typeof buildGlossaryIndex>} index
 * @returns {string[]} canonical term keys
 */
export function termsInText(text, index) {
  if (!index || !index.regex || !text) return [];
  index.regex.lastIndex = 0;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = index.regex.exec(text))) {
    // Defensive: never let a zero-width match stall the loop.
    if (m.index === index.regex.lastIndex) index.regex.lastIndex += 1;
    const canon = index.lower[m[1].toLowerCase()];
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

/**
 * Flattens a card's visible prose (request, proposed action, context values,
 * list items, evidence names/extras) into one string for term matching.
 *
 * @param {object[]} blocks - card_blocks from the verdict queue item
 * @returns {string}
 */
export function cardProse(blocks) {
  const parts = [];
  for (const b of blocks || []) {
    if (b.text) parts.push(String(b.text));
    if (b.tag) parts.push(String(b.tag));
    if (b.kind === "context") {
      for (const kv of b.items || []) parts.push(String(kv[0]) + " " + String(kv[1]));
    }
    if (b.kind === "list") {
      for (const x of b.items || []) parts.push(String(x));
    }
    if (b.kind === "evidence") {
      for (const e of b.items || []) {
        if (e.name) parts.push(String(e.name));
        if (e.extra) parts.push(String(e.extra));
      }
    }
  }
  return parts.join("  ");
}

/**
 * Computes the glossary terms present on a card: the discrete labels on the card
 * (risk-flag chips and evidence statuses) plus any glossary term that appears in
 * the card's prose. Deduplicated, only terms that exist in the glossary.
 *
 * @param {object[]} blocks - card_blocks
 * @param {ReturnType<typeof buildGlossaryIndex>} index
 * @returns {string[]} canonical term keys present on the card
 */
export function cardTerms(blocks, index) {
  const keys = [];
  for (const b of blocks || []) {
    if (b.kind === "chips") for (const x of b.items || []) keys.push(x);
    if (b.kind === "evidence") for (const e of b.items || []) { if (e.status) keys.push(e.status); }
  }
  for (const t of termsInText(cardProse(blocks), index)) keys.push(t);
  return keys.filter((k, i) => index.map[k] && keys.indexOf(k) === i);
}
