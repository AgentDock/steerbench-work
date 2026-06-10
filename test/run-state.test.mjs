// Tests for run-state lifecycle, focused on the partial-run safety guard.
//
// A subset run must never look like a completed reported run. These tests
// pin the PARTIAL status behavior: partial keeps the overall run
// in_progress, a partial variant is resumable, and a completed variant is
// still refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOverallStatus,
  canStartVariant,
  VARIANT_STATUS,
  OVERALL_STATUS
} from "../src/run-state.mjs";

test("a partial variant keeps the overall run in_progress", () => {
  const overall = computeOverallStatus(
    { a: { status: VARIANT_STATUS.PARTIAL } },
    ["a"]
  );
  assert.equal(overall, OVERALL_STATUS.IN_PROGRESS);
});

test("partial does not let a run report completed", () => {
  const overall = computeOverallStatus(
    { a: { status: VARIANT_STATUS.COMPLETED }, b: { status: VARIANT_STATUS.PARTIAL } },
    ["a", "b"]
  );
  assert.notEqual(overall, OVERALL_STATUS.COMPLETED);
});

test("a partial variant is resumable", () => {
  const gate = canStartVariant({ status: VARIANT_STATUS.PARTIAL });
  assert.equal(gate.allowed, true);
  assert.equal(gate.isResume, true);
});

test("a completed variant is still refused", () => {
  const gate = canStartVariant({ status: VARIANT_STATUS.COMPLETED });
  assert.equal(gate.allowed, false);
});

test("all variants completed reports completed", () => {
  const overall = computeOverallStatus(
    { a: { status: VARIANT_STATUS.COMPLETED } },
    ["a"]
  );
  assert.equal(overall, OVERALL_STATUS.COMPLETED);
});
