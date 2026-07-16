// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAcCoverage } from "../../lib/spec-progress.mjs";

/**
 * @param {number} id
 * @param {string} [text]
 * @returns {{ id: number, stepId: string, text: string }}
 */
function criterion(id, text = `criterion ${id}`) {
  return { id, stepId: `impl-AC${id}`, text };
}

test("computeAcCoverage: empty criteria is vacuously ok at 100%", () => {
  const result = computeAcCoverage([], []);
  assert.deepEqual(result, {
    ok: true,
    total: 0,
    completed: 0,
    coveragePercent: 100,
    missing: [],
  });
});

test("computeAcCoverage: all complete is ok with no missing", () => {
  const criteria = [criterion(1), criterion(2), criterion(3)];
  const result = computeAcCoverage(criteria, [1, 2, 3]);
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.coveragePercent, 100);
  assert.deepEqual(result.missing, []);
});

test("computeAcCoverage: partial completion reports missing in id order with text", () => {
  const criteria = [
    criterion(1, "first"),
    criterion(2, "second"),
    criterion(3, "third"),
  ];
  const result = computeAcCoverage(criteria, [1, 3]);
  assert.equal(result.ok, false);
  assert.equal(result.total, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.coveragePercent, 66);
  assert.deepEqual(result.missing, [{ id: 2, text: "second" }]);
});

test("computeAcCoverage: completedIds out of order does not affect the result", () => {
  const criteria = [criterion(1), criterion(2), criterion(3)];
  const inOrder = computeAcCoverage(criteria, [1, 2, 3]);
  const outOfOrder = computeAcCoverage(criteria, [3, 1, 2]);
  assert.deepEqual(inOrder, outOfOrder);
});

test("computeAcCoverage: duplicate ids in criteria are deduped, never throw", () => {
  const criteria = [
    criterion(1, "first"),
    criterion(1, "first duplicate"),
    criterion(2, "second"),
  ];
  const result = computeAcCoverage(criteria, [1]);
  assert.equal(result.total, 2);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.missing, [{ id: 2, text: "second" }]);
});

test("computeAcCoverage: completedIds referencing ids not in criteria are ignored", () => {
  const criteria = [criterion(1), criterion(2)];
  const result = computeAcCoverage(criteria, [1, 2, 99]);
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.missing, []);
});

test("computeAcCoverage: is pure — identical input yields identical output", () => {
  const criteria = [criterion(1), criterion(2), criterion(3)];
  const completedIds = [1];
  const first = computeAcCoverage(criteria, completedIds);
  const second = computeAcCoverage(criteria, completedIds);
  assert.deepEqual(first, second);
  // Inputs must be left untouched (no I/O, no mutation).
  assert.deepEqual(completedIds, [1]);
  assert.equal(criteria.length, 3);
});
