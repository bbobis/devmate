// @ts-check
/**
 * FO-5: scoped-discovery dispatch completeness checks — mirrors the E10-06
 * poka-yoke tests for `buildDispatchPayload` (see
 * build-dispatch-payload.completeness.test.mjs): every required field
 * missing or empty throws an error naming exactly that field, and a
 * complete dispatch renders every section including the structural
 * partition boundaries.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDiscoveryDispatch,
  REQUIRED_DISCOVERY_DISPATCH_FIELDS,
} from '../../../lib/workflow/build-discovery-dispatch.mjs';

/**
 * A fully specified dispatch builder input.
 * @returns {import('../../../lib/workflow/build-discovery-dispatch.mjs').BuildDiscoveryDispatchOptions}
 */
function completeOptions() {
  return {
    angle: 'entry points & routing',
    objective: 'Locate where gate transitions are validated',
    outputFormat: 'Return { claims: [{ fact, path, confidence }], unverified: [] } JSON',
    toolGuidance: 'search then read minimal slices; issue multiple search tool calls per turn',
    boundaries: 'Investigate only workflow gating concerns for this task',
    thoroughness: 'medium',
    taskStatement: 'The team is wiring a two-phase discovery fan-out into the feature lane.',
    candidates: [
      { path: 'lib/gatectl.mjs', why: 'name match: gate' },
      { path: 'lib/gate-guard-core.mjs', why: 'content match: 12 lines', lineAnchor: { start: 40, end: 80 } },
    ],
    maxFileSlices: 5,
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

test('discovery-dispatch › REQUIRED_DISCOVERY_DISPATCH_FIELDS names exactly the seven fields', () => {
  assert.deepEqual(
    [...REQUIRED_DISCOVERY_DISPATCH_FIELDS],
    ['angle', 'objective', 'outputFormat', 'toolGuidance', 'boundaries', 'thoroughness', 'taskStatement'],
  );
});

for (const field of REQUIRED_DISCOVERY_DISPATCH_FIELDS) {
  test(`discovery-dispatch › payload missing ${field} throws naming the field`, () => {
    const opts = /** @type {Record<string, unknown>} */ (
      /** @type {unknown} */ (completeOptions())
    );
    delete opts[field];
    assert.throws(
      () =>
        buildDiscoveryDispatch(
          /** @type {import('../../../lib/workflow/build-discovery-dispatch.mjs').BuildDiscoveryDispatchOptions} */ (
            /** @type {unknown} */ (opts)
          ),
        ),
      namesMissingField(field),
    );
  });

  test(`discovery-dispatch › payload with empty ${field} throws naming the field`, () => {
    const opts = completeOptions();
    /** @type {Record<string, unknown>} */ (
      /** @type {unknown} */ (opts)
    )[field] = '   ';
    assert.throws(() => buildDiscoveryDispatch(opts), namesMissingField(field));
  });
}

test('discovery-dispatch › an unknown thoroughness value throws', () => {
  const opts = completeOptions();
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).thoroughness = 'exhaustive';
  assert.throws(
    () => buildDiscoveryDispatch(opts),
    /thoroughness must be one of quick\|medium\|thorough/,
  );
});

test('discovery-dispatch › missing or empty candidates throws naming the field', () => {
  for (const bad of [undefined, [], 'lib/a.mjs']) {
    const opts = completeOptions();
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).candidates = bad;
    assert.throws(() => buildDiscoveryDispatch(opts), namesMissingField('candidates'));
  }
});

test('discovery-dispatch › a candidate without a path throws naming the index', () => {
  const opts = completeOptions();
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).candidates = [
    { path: 'lib/a.mjs' },
    { why: 'no path here' },
  ];
  assert.throws(() => buildDiscoveryDispatch(opts), /candidates\[1\] must carry a non-empty string path/);
});

test('discovery-dispatch › a malformed lineAnchor throws naming the index (never renders an invalid pointer)', () => {
  const badAnchors = [
    null,
    'L40-80',
    { start: 0, end: 10 },
    { start: 5.5, end: 10 },
    { start: 10, end: 5 },
    { start: 10 },
  ];
  for (const bad of badAnchors) {
    const opts = completeOptions();
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).candidates = [
      { path: 'lib/a.mjs', lineAnchor: bad },
    ];
    assert.throws(
      () => buildDiscoveryDispatch(opts),
      /candidates\[0\]\.lineAnchor must be/,
      `anchor ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('discovery-dispatch › an invalid maxFileSlices throws naming the field', () => {
  for (const bad of [undefined, 0, -1, 1.5, Number.NaN, '5']) {
    const opts = completeOptions();
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).maxFileSlices = bad;
    assert.throws(() => buildDiscoveryDispatch(opts), namesMissingField('maxFileSlices'));
  }
});

test('discovery-dispatch › a complete dispatch renders every section', () => {
  const prompt = buildDiscoveryDispatch(completeOptions());

  assert.match(prompt, /## Task statement\n\nThe team is wiring a two-phase discovery fan-out/);
  assert.match(prompt, /## Angle: entry points & routing/);
  assert.match(prompt, /## Objective\n\nLocate where gate transitions are validated/);
  assert.match(prompt, /## Output format\n\nReturn \{ claims:/);
  assert.match(prompt, /## Tool guidance\n\nsearch then read minimal slices; issue multiple search tool calls per turn/);
  assert.match(prompt, /## Thoroughness: medium/);
  assert.match(prompt, /## Boundaries\n\nInvestigate only workflow gating concerns/);
});

test('discovery-dispatch › boundaries always carry the partition pointers and hard rules', () => {
  const prompt = buildDiscoveryDispatch(completeOptions());

  // Candidate pointers: path + optional line anchor + one-line why.
  assert.match(prompt, /- lib\/gatectl\.mjs — name match: gate/);
  assert.match(prompt, /- lib\/gate-guard-core\.mjs#L40-L80 — content match: 12 lines/);

  // Structural worker rules, appended by the builder itself.
  assert.match(prompt, /Do not read outside your candidate partition's directories\./);
  assert.match(prompt, /Read at most 5 file slices\./);
  assert.match(
    prompt,
    /Return claims with evidence paths; anything uncertain goes to unverified; do NOT echo the candidate list back\./,
  );
});

test('discovery-dispatch › pointers only — no file content is ever inlined', () => {
  const prompt = buildDiscoveryDispatch(completeOptions());
  // The partition section lists paths as markdown bullets; nothing else from
  // the candidate objects (e.g. no scores, no strategy arrays) leaks in.
  assert.doesNotMatch(prompt, /score/);
  assert.doesNotMatch(prompt, /strategies/);
});

test('discovery-dispatch › validation runs before any rendering (poka-yoke ordering)', () => {
  const opts = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (completeOptions())
  );
  delete opts['angle'];
  // candidates deliberately broken too — the field error must win (checked first).
  opts['candidates'] = [];
  assert.throws(
    () =>
      buildDiscoveryDispatch(
        /** @type {import('../../../lib/workflow/build-discovery-dispatch.mjs').BuildDiscoveryDispatchOptions} */ (
          /** @type {unknown} */ (opts)
        ),
      ),
    namesMissingField('angle'),
  );
});

test('discovery-dispatch › modelHint renders the advisory line (FO-7)', () => {
  const prompt = buildDiscoveryDispatch({ ...completeOptions(), modelHint: 'routed-model-x' });
  assert.match(prompt, /Preferred model for this worker: routed-model-x \(advisory\)/);
});

test('discovery-dispatch › omitting modelHint renders no advisory line', () => {
  const prompt = buildDiscoveryDispatch(completeOptions());
  assert.doesNotMatch(prompt, /Preferred model for this worker:/);
});

test('discovery-dispatch › a blank or non-string modelHint throws (never a meaningless advisory line)', () => {
  for (const bad of ['', '   ', 42]) {
    const opts = completeOptions();
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (opts)).modelHint = bad;
    assert.throws(
      () => buildDiscoveryDispatch(opts),
      /'modelHint' must be a non-empty string when present/,
      `modelHint ${JSON.stringify(bad)} must be rejected`,
    );
  }
});
