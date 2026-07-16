// @ts-check

/**
 * AC-2 of the deterministic AC coverage harness (epic #416): the
 * `acCoveragePrecondition` shared helper, merged into `verification-passed`
 * and added as a new `pr-ready` entry in `lib/gate-preconditions.mjs`. Mirrors
 * the fixture style of test/lib/gate-preconditions.impl-floor.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

/**
 * @param {number} n
 * @returns {Record<string, unknown>}
 */
function acCompleteEvent(n) {
  return {
    type: 'step_complete',
    stepId: `impl-AC${n}`,
    taskId: 't',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    label: `AC${n} complete`,
    artifactPaths: [],
  };
}

const SPEC_3_AC = [
  '# spec',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] AC1: first criterion',
  '- [ ] AC2: second criterion',
  '- [ ] AC3: third criterion',
  '',
].join('\n');

const SPEC_ZERO_AC = ['# spec', '', 'No acceptance criteria section here.', ''].join('\n');

/**
 * @param {{ mode?: string, spec?: string, trace?: Array<Record<string, unknown>>, taskId?: string, lane?: string }} [opts]
 */
function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acgate-'));
  const devmate = join(root, '.devmate');
  const stateDir = join(devmate, 'state');
  const sessionDir = join(devmate, 'session');
  mkdirSync(join(stateDir, 'trace'), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  /** @type {Record<string, unknown>} */
  const config = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['**'] }] };
  if (opts.mode !== undefined) config.acCoverageGate = opts.mode;
  writeFileSync(join(devmate, 'devmate.config.json'), JSON.stringify(config), 'utf8');

  writeFileSync(join(sessionDir, 'spec.md'), opts.spec ?? SPEC_3_AC, 'utf8');

  const taskId = opts.taskId ?? 't';
  writeFileSync(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId,
      lane: opts.lane ?? 'feature',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  if (opts.trace) {
    writeFileSync(
      join(stateDir, 'trace', `${taskId}.jsonl`),
      opts.trace.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }
  return { root, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Write a fresh, passing, spec-matching verify-result.json so the existing
 * verify-evidence checks in `verification-passed` do not also fire.
 * @param {string} stateDir
 */
function writeFreshVerifyEvidence(stateDir) {
  writeFileSync(
    join(stateDir, 'verify-result.json'),
    JSON.stringify({
      passed: true,
      digest: 'ok',
      fullOutputPath: '/tmp/full.log',
      completedAt: new Date().toISOString(),
      specDigest: '',
    }),
    'utf8',
  );
}

for (const gate of ['verification-passed', 'pr-ready']) {
  test(`ac-coverage / mode off (default) → ok, no read, no trace churn (${gate})`, async () => {
    const fx = makeFixture({});
    try {
      const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
      // verification-passed also needs its own verify-evidence to be present
      // for a bare ok:true — but 'off' mode must not itself add any failure
      // regardless, so assert the ac-coverage-specific reason is absent (the
      // check message always starts with the literal prefix "ac-coverage: ").
      assert.ok(!r.missing.some((m) => m.startsWith('ac-coverage: ')));
    } finally {
      fx.cleanup();
    }
  });

  test(`ac-coverage / mode block, 1 of 3 ACs complete → refused, missing names AC2+AC3 (${gate})`, async () => {
    const fx = makeFixture({ mode: 'block', trace: [acCompleteEvent(1)] });
    try {
      if (gate === 'verification-passed') writeFreshVerifyEvidence(fx.stateDir);
      const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
      assert.equal(r.ok, false);
      const joined = r.missing.join(' | ');
      assert.match(joined, /AC2/);
      assert.match(joined, /second criterion/);
      assert.match(joined, /AC3/);
      assert.match(joined, /third criterion/);
      assert.doesNotMatch(joined, /AC1 not complete/);
    } finally {
      fx.cleanup();
    }
  });

  test(`ac-coverage / mode warn, 1 of 3 ACs complete → allowed, contract_violation recorded once (${gate})`, async () => {
    const fx = makeFixture({ mode: 'warn', trace: [acCompleteEvent(1)] });
    try {
      if (gate === 'verification-passed') writeFreshVerifyEvidence(fx.stateDir);
      const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
      assert.equal(r.ok, true, 'warn mode must not block the transition');

      // @bounded-alloc — reads the one trace file this test's own fixture wrote.
      const lines = /** @type {any[]} */ (parseJsonl(readFileSync(join(fx.stateDir, 'trace', 't.jsonl'), 'utf8')));
      const violations = lines.filter((e) => e.type === 'contract_violation' && e.contract === 'ac-coverage');
      assert.equal(violations.length, 1, 'exactly one ac-coverage contract_violation must be recorded');
      assert.ok(Array.isArray(violations[0].errors) && violations[0].errors.length === 2);
    } finally {
      fx.cleanup();
    }
  });

  test(`ac-coverage / all ACs complete → allowed in every mode (${gate})`, async () => {
    for (const mode of ['off', 'warn', 'block']) {
      const fx = makeFixture({ mode, trace: [acCompleteEvent(1), acCompleteEvent(2), acCompleteEvent(3)] });
      try {
        if (gate === 'verification-passed') writeFreshVerifyEvidence(fx.stateDir);
        const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
        assert.equal(r.ok, true, `mode ${mode} should allow full coverage`);
      } finally {
        fx.cleanup();
      }
    }
  });

  test(`ac-coverage / feature lane + zero parsed ACs + mode block → fail-closed refusal (${gate})`, async () => {
    const fx = makeFixture({ mode: 'block', spec: SPEC_ZERO_AC });
    try {
      if (gate === 'verification-passed') writeFreshVerifyEvidence(fx.stateDir);
      const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
      assert.equal(r.ok, false);
      assert.match(r.missing.join(' '), /no acceptance criteria parsed/);
    } finally {
      fx.cleanup();
    }
  });

  test(`ac-coverage / chore lane + zero parsed ACs + mode block → passes (no analysis-coverage expectation) (${gate})`, async () => {
    const fx = makeFixture({ mode: 'block', spec: SPEC_ZERO_AC, lane: 'chore' });
    try {
      if (gate === 'verification-passed') writeFreshVerifyEvidence(fx.stateDir);
      const r = await checkGatePrecondition(gate, { stateDir: fx.stateDir, lane: 'chore', taskId: 't' });
      assert.equal(r.ok, true);
    } finally {
      fx.cleanup();
    }
  });
}

test('ac-coverage / verification-passed: partial coverage + valid verify evidence → still refused (both checks independent)', async () => {
  const fx = makeFixture({ mode: 'block', trace: [acCompleteEvent(1)] });
  try {
    writeFreshVerifyEvidence(fx.stateDir);
    const r = await checkGatePrecondition('verification-passed', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /AC2/);
  } finally {
    fx.cleanup();
  }
});

test('ac-coverage / verification-passed: full coverage + stale verify evidence → refused on the verify reason', async () => {
  const fx = makeFixture({ mode: 'block', trace: [acCompleteEvent(1), acCompleteEvent(2), acCompleteEvent(3)] });
  try {
    writeFileSync(
      join(fx.stateDir, 'verify-result.json'),
      JSON.stringify({
        passed: true,
        digest: 'ok',
        fullOutputPath: '/tmp/full.log',
        completedAt: '2000-01-01T00:00:00.000Z', // ancient — stale
        specDigest: '',
      }),
      'utf8',
    );
    const r = await checkGatePrecondition('verification-passed', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /stale/);
    // The ac-coverage check itself passed (full coverage), so only the verify
    // reason should appear — proving the two checks are independent.
    assert.ok(!r.missing.some((m) => m.startsWith('ac-coverage: ')));
  } finally {
    fx.cleanup();
  }
});

test('ac-coverage / pr-ready: mode block refuses on its own (backstop, no verify-evidence check there)', async () => {
  const fx = makeFixture({ mode: 'block', trace: [] });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /AC1/);
  } finally {
    fx.cleanup();
  }
});

test('ac-coverage / taskId resolved from task.json when ctx.taskId absent', async () => {
  const fx = makeFixture({ mode: 'block', taskId: 'feat-9', trace: [] });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /AC1/);
  } finally {
    fx.cleanup();
  }
});
