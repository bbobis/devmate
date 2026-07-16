// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INITIAL_TDD_GUARD,
  evaluateTddPreCondition,
  applyTddGuardTransition,
} from "../../lib/gate-guard-core.mjs";

const TEST_GLOBS = ["test/**", "**/*.test.mjs"];

test("evaluateTddPreCondition blocks first non-test source write", () => {
  const result = evaluateTddPreCondition(
    "lib/feature.mjs",
    { ...INITIAL_TDD_GUARD },
    TEST_GLOBS,
  );
  assert.equal(result, "block");
});

test("evaluateTddPreCondition allows source write after a test file is written", () => {
  const result = evaluateTddPreCondition(
    "lib/feature.mjs",
    {
      testFileWritten: true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    TEST_GLOBS,
  );
  assert.equal(result, "allow");
});

test("evaluateTddPreCondition allows any write when override is granted", () => {
  const result = evaluateTddPreCondition(
    "lib/feature.mjs",
    {
      testFileWritten: false,
      consecutiveNonTestWrites: 9,
      overrideGranted: true,
    },
    TEST_GLOBS,
  );
  assert.equal(result, "allow");
});

test("applyTddGuardTransition marks testFileWritten true and resets counter for test file paths", () => {
  const next = applyTddGuardTransition(
    {
      testFileWritten: false,
      consecutiveNonTestWrites: 3,
      overrideGranted: false,
    },
    "allow",
    "test/feature.test.mjs",
    TEST_GLOBS,
  );

  assert.equal(next.testFileWritten, true);
  assert.equal(next.consecutiveNonTestWrites, 0);
});

test("applyTddGuardTransition increments consecutiveNonTestWrites on blocked source path", () => {
  const next = applyTddGuardTransition(
    {
      testFileWritten: false,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    "block",
    "lib/feature.mjs",
    TEST_GLOBS,
  );

  assert.equal(next.consecutiveNonTestWrites, 1);
});
