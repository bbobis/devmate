// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acStepId,
  completedAcNumbers,
  nextAcNumber,
  parseAcceptanceCriteria,
  renderCheckedSpec,
  summarizeImplProgress,
} from "../../lib/spec-progress.mjs";

const SPEC = [
  "# Spec: demo",
  "",
  "## Assumptions — please verify",
  "- [ ] this is an assumption, not an AC",
  "",
  "## Acceptance criteria",
  "- [ ] AC1: first criterion",
  "- [ ] AC2: second criterion",
  "- [ ] AC3: third criterion",
  "",
  "## Test plan",
  "| ID | Description |",
  "| --- | --- |",
  "| TC-001 | t |",
  "",
].join("\n");

test("parseAcceptanceCriteria: reads only the AC section, in order", () => {
  const acs = parseAcceptanceCriteria(SPEC);
  assert.deepEqual(
    acs.map((a) => a.id),
    [1, 2, 3],
  );
  assert.equal(acs[0].stepId, "impl-AC1");
  assert.equal(acs[0].text, "first criterion");
  // The assumptions checkbox above must NOT be picked up.
  assert.equal(acs.length, 3);
});

test("parseAcceptanceCriteria: tolerates already-checked lines", () => {
  const md = SPEC.replace("- [ ] AC2:", "- [x] AC2:");
  const acs = parseAcceptanceCriteria(md);
  assert.deepEqual(
    acs.map((a) => a.id),
    [1, 2, 3],
  );
});

test("renderCheckedSpec: checks only completed ids, leaves others untouched", () => {
  const out = renderCheckedSpec(SPEC, new Set([1, 3]));
  assert.match(out, /- \[x\] AC1: first criterion/);
  assert.match(out, /- \[ \] AC2: second criterion/);
  assert.match(out, /- \[x\] AC3: third criterion/);
  // The assumptions checkbox stays unchecked.
  assert.match(out, /- \[ \] this is an assumption/);
});

test("renderCheckedSpec: never unchecks and is idempotent", () => {
  const once = renderCheckedSpec(SPEC, new Set([2]));
  const twice = renderCheckedSpec(once, new Set([2]));
  assert.equal(once, twice);
  // Re-rendering with an empty set must not uncheck AC2.
  const empty = renderCheckedSpec(once, new Set());
  assert.match(empty, /- \[x\] AC2: second criterion/);
});

test("renderCheckedSpec: only touches ids inside the AC section", () => {
  // An AC-shaped line outside the section must be ignored.
  const md = [
    "## Notes",
    "- [ ] AC1: decoy outside the section",
    "",
    "## Acceptance criteria",
    "- [ ] AC1: real criterion",
    "",
  ].join("\n");
  const out = renderCheckedSpec(md, new Set([1]));
  assert.match(out, /- \[ \] AC1: decoy outside the section/);
  assert.match(out, /- \[x\] AC1: real criterion/);
});

test("completedAcNumbers: only completed impl-AC steps, sorted & deduped", () => {
  /** @type {import('../../lib/types.mjs').TraceStep[]} */
  const steps = /** @type {any} */ ([
    { stepId: "impl-AC3", completed: true },
    { stepId: "impl-AC1", completed: true },
    { stepId: "impl-AC2", completed: false },
    { stepId: "discovery", completed: true },
    { stepId: "impl-AC1", completed: true },
  ]);
  assert.deepEqual(completedAcNumbers(steps), [1, 3]);
});

test("nextAcNumber: smallest incomplete, or null when all done", () => {
  assert.equal(nextAcNumber(new Set([1, 2]), 3), 3);
  assert.equal(nextAcNumber(new Set([1, 3]), 3), 2);
  assert.equal(nextAcNumber(new Set([1, 2, 3]), 3), null);
  assert.equal(nextAcNumber(new Set(), 0), null);
});

test("summarizeImplProgress: joins ids with labels", () => {
  const labels = ["first", "second", "third"];
  const p = summarizeImplProgress([1, 2], labels);
  assert.equal(p.done, 2);
  assert.equal(p.total, 3);
  assert.equal(p.nextId, 3);
  assert.equal(p.nextLabel, "third");
  assert.deepEqual(p.completedIds, [1, 2]);
});

test("summarizeImplProgress: all complete → nextId null", () => {
  const p = summarizeImplProgress([1, 2, 3], ["a", "b", "c"]);
  assert.equal(p.nextId, null);
  assert.equal(p.nextLabel, null);
  assert.equal(p.done, 3);
});

test("summarizeImplProgress: unknown label list → total 0, next null", () => {
  const p = summarizeImplProgress([1, 2], undefined);
  assert.equal(p.total, 0);
  assert.equal(p.done, 2);
  assert.equal(p.nextId, null);
});

test("acStepId: stable positional id", () => {
  assert.equal(acStepId(5), "impl-AC5");
});
