// @ts-check
/**
 * E10-06: dispatch-payload completeness checks (R6 poka-yoke).
 *
 * `buildDispatchPayload` must reject payloads missing any of the four
 * required dispatch fields — objective, outputFormat, toolGuidance,
 * boundaries — with an error naming the missing field, so no
 * under-specified subagent is ever dispatched. A complete payload builds
 * and renders all four values as dedicated prompt sections.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildDispatchPayload,
  REQUIRED_DISPATCH_FIELDS,
} from '../../../lib/workflow/build-dispatch-payload.mjs';

/**
 * @param {object} plan
 * @returns {{ dir: string, planPath: string, cleanup: () => void }}
 */
function writePlan(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-completeness-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  return { dir, planPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @returns {object} */
function tddPlan() {
  return {
    tasks: [
      {
        id: 'AC-1',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/foo.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  };
}

/**
 * A fully specified payload builder input. Field values deliberately avoid
 * tool-specific command names so the existing no-tool-defaults invariant of
 * the builder stays observable.
 * @param {string} planPath
 * @returns {import('../../../lib/workflow/build-dispatch-payload.mjs').BuildDispatchPayloadOptions}
 */
function completeOptions(planPath) {
  return {
    objective: 'Implement AC-1 exactly as planned',
    outputFormat: 'Return a WorkerReturn-shaped JSON result object',
    toolGuidance: 'Use repo-configured verification commands only',
    boundaries: 'Touch only files owned by the frontend persona',
    persona: 'frontend',
    tasks: [{ id: 'AC-1', description: 'do thing' }],
    planPath,
    config: {
      schemaVersion: 1,
      personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
      verification: { unitTest: 'run-unit-tests' },
    },
  };
}

/**
 * Build an assert.throws predicate matching the field-naming completeness
 * error (string containment — no dynamic RegExp construction).
 * @param {string} field
 * @returns {(err: unknown) => boolean}
 */
function namesMissingField(field) {
  return (err) =>
    err instanceof Error &&
    err.message.includes(`missing required dispatch field '${field}'`);
}

test('completeness › REQUIRED_DISPATCH_FIELDS names exactly the four required fields', () => {
  assert.deepEqual(
    [...REQUIRED_DISPATCH_FIELDS],
    ['objective', 'outputFormat', 'toolGuidance', 'boundaries'],
  );
});

for (const field of ['objective', 'outputFormat', 'toolGuidance', 'boundaries']) {
  test(`completeness › payload missing ${field} throws naming the field`, () => {
    const fixture = writePlan(tddPlan());
    try {
      const opts = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (completeOptions(fixture.planPath))
      );
      delete opts[field];
      assert.throws(
        () =>
          buildDispatchPayload(
            /** @type {import('../../../lib/workflow/build-dispatch-payload.mjs').BuildDispatchPayloadOptions} */ (
              /** @type {unknown} */ (opts)
            ),
          ),
        namesMissingField(field),
      );
    } finally {
      fixture.cleanup();
    }
  });

  test(`completeness › payload with empty ${field} throws naming the field`, () => {
    const fixture = writePlan(tddPlan());
    try {
      const opts = completeOptions(fixture.planPath);
      /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (opts)
      )[field] = '   ';
      assert.throws(() => buildDispatchPayload(opts), namesMissingField(field));
    } finally {
      fixture.cleanup();
    }
  });
}

test('completeness › a complete payload builds with all four sections rendered', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload(completeOptions(fixture.planPath));

    assert.match(payload, /## Objective\n\nImplement AC-1 exactly as planned/);
    assert.match(payload, /## Output format\n\nReturn a WorkerReturn-shaped JSON result object/);
    assert.match(payload, /## Tool guidance\n\nUse repo-configured verification commands only/);
    assert.match(payload, /## Boundaries\n\nTouch only files owned by the frontend persona/);
    // Pre-E10-06 sections are still present (no regression).
    assert.match(payload, /TDD_PREAMBLE_REQUIRED/);
    assert.match(payload, /## Persona context/);
    assert.match(payload, /## Task list/);
    assert.match(payload, /## Verification/);
  } finally {
    fixture.cleanup();
  }
});

test('completeness › validation runs before any plan read (poka-yoke ordering)', () => {
  // An under-specified payload must throw the field-naming error even when
  // the plan path is unreadable — nothing else about the dispatch is
  // consulted before completeness passes.
  const opts = completeOptions(join(tmpdir(), 'dispatch-completeness-nonexistent', 'plan.json'));
  const underSpecified = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (opts)
  );
  delete underSpecified['objective'];
  assert.throws(
    () =>
      buildDispatchPayload(
        /** @type {import('../../../lib/workflow/build-dispatch-payload.mjs').BuildDispatchPayloadOptions} */ (
          /** @type {unknown} */ (underSpecified)
        ),
      ),
    /missing required dispatch field 'objective'/,
  );
});
