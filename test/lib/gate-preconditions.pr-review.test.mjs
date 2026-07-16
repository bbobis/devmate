// @ts-check

/**
 * PRR-3: the config-gated `prReviewPrecondition`, merged into the `pr-ready`
 * gate entry in `lib/gate-preconditions.mjs`. Mirrors the fixture style of
 * test/lib/gate-preconditions.ac-coverage.test.mjs — the AC-coverage template
 * this gate was built from. Only `prReviewGate` is set in the fixture config
 * (acCoverageGate stays off), so the pr-ready entry's other sub-check is a
 * no-op and these assertions isolate the pr-review behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

/**
 * Build a valid PrReviewArtifact (verdict defaults to APPROVE).
 * @param {{ taskId?: string, lane?: string, verdict?: string }} [opts]
 * @returns {Record<string, unknown>}
 */
function prReviewArtifact(opts = {}) {
  return {
    taskId: opts.taskId ?? 't',
    lane: opts.lane ?? 'feature',
    schemaVersion: 1,
    returnedAt: '2026-07-05T00:00:00.000Z',
    contextDigest: 'ctx-digest-abc',
    verdict: opts.verdict ?? 'APPROVE',
    findings: [],
    alignment: { ok: true, outOfScopeFiles: [], unlistedFiles: [], missingRegressionTest: false },
    unverified: [],
  };
}

/**
 * @param {{ mode?: string, taskId?: string, lane?: string, result?: unknown }} [opts]
 */
function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prgate-'));
  const devmate = join(root, '.devmate');
  const stateDir = join(devmate, 'state');
  mkdirSync(join(stateDir, 'trace'), { recursive: true });

  /** @type {Record<string, unknown>} */
  const config = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['**'] }] };
  if (opts.mode !== undefined) config.prReviewGate = opts.mode;
  writeFileSync(join(devmate, 'devmate.config.json'), JSON.stringify(config), 'utf8');

  const taskId = opts.taskId ?? 't';
  writeFileSync(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId,
      lane: opts.lane ?? 'feature',
      workflowGate: 'verification-passed',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  if (opts.result !== undefined) {
    const body = typeof opts.result === 'string' ? opts.result : JSON.stringify(opts.result);
    writeFileSync(join(stateDir, 'pr-review-result.json'), body, 'utf8');
  }
  return { root, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('pr-review / mode off (default, no key) → ok, no read of a missing verdict', async () => {
  const fx = makeFixture({});
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
    assert.ok(!r.missing.some((m) => m.startsWith('pr-review: ')));
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode off explicit → ok even with a missing verdict', async () => {
  const fx = makeFixture({ mode: 'off' });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
    assert.ok(!r.missing.some((m) => m.startsWith('pr-review: ')));
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + missing verdict → refused with a clear message', async () => {
  const fx = makeFixture({ mode: 'block' });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /pr-review: .*not found/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + unparseable verdict → refused', async () => {
  const fx = makeFixture({ mode: 'block', result: '{ not json' });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /pr-review: .*not found|unparseable/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + structurally invalid verdict → refused with invalid message', async () => {
  const fx = makeFixture({ mode: 'block', result: { taskId: 't', lane: 'feature' } });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /pr-review: review verdict invalid/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + REQUEST_CHANGES verdict → refused (not APPROVE)', async () => {
  const fx = makeFixture({
    mode: 'block',
    result: prReviewArtifact({ verdict: 'REQUEST_CHANGES: out-of-scope files changed' }),
  });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /not APPROVE/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + APPROVE (matching taskId + lane) → ok', async () => {
  const fx = makeFixture({ mode: 'block', result: prReviewArtifact({ taskId: 't', lane: 'feature' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + APPROVE also holds on the bug lane', async () => {
  const fx = makeFixture({ mode: 'block', lane: 'bug', result: prReviewArtifact({ taskId: 't', lane: 'bug' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'bug', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + taskId mismatch → refused', async () => {
  const fx = makeFixture({ mode: 'block', taskId: 't', result: prReviewArtifact({ taskId: 'other', lane: 'feature' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /belongs to task "other"/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + lane mismatch → refused', async () => {
  const fx = makeFixture({ mode: 'block', lane: 'feature', result: prReviewArtifact({ taskId: 't', lane: 'bug' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /lane "bug" does not match/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode warn + missing verdict → allowed AND a pr-review contract_violation recorded once', async () => {
  const fx = makeFixture({ mode: 'warn' });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true, 'warn mode must not block the transition');

    // @bounded-alloc — reads the one trace file this test's own fixture wrote.
    const lines = /** @type {any[]} */ (parseJsonl(readFileSync(join(fx.stateDir, 'trace', 't.jsonl'), 'utf8')));
    const violations = lines.filter((e) => e.type === 'contract_violation' && e.contract === 'pr-review');
    assert.equal(violations.length, 1, 'exactly one pr-review contract_violation must be recorded');
    assert.equal(violations[0].path, 'feature/pr-ready');
    assert.ok(Array.isArray(violations[0].errors) && violations[0].errors.length >= 1);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / taskId resolved from task.json when ctx.taskId absent (block + APPROVE) → ok', async () => {
  const fx = makeFixture({ mode: 'block', taskId: 'feat-9', result: prReviewArtifact({ taskId: 'feat-9', lane: 'feature' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / taskId resolved from task.json when ctx.taskId absent (block + mismatch) → refused', async () => {
  const fx = makeFixture({ mode: 'block', taskId: 'feat-9', result: prReviewArtifact({ taskId: 'wrong', lane: 'feature' }) });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' | '), /belongs to task "wrong"/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode block + unresolvable taskId → fails closed (no ctx.taskId, no task.json)', async () => {
  const fx = makeFixture({ mode: 'block', result: prReviewArtifact({ taskId: 't', lane: 'feature' }) });
  rmSync(join(fx.stateDir, 'task.json'), { force: true }); // taskId now unresolvable
  try {
    // A valid APPROVE artifact exists, but its ownership cannot be confirmed —
    // block must refuse rather than accept it (regression: PR #68 review).
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, false, 'block must refuse when the verdict cannot be tied to a task');
    assert.match(r.missing.join(' | '), /taskId could not be resolved/);
  } finally {
    fx.cleanup();
  }
});

test('pr-review / mode warn + unresolvable taskId → allowed (fail open only in warn)', async () => {
  const fx = makeFixture({ mode: 'warn', result: prReviewArtifact({ taskId: 't', lane: 'feature' }) });
  rmSync(join(fx.stateDir, 'task.json'), { force: true });
  try {
    const r = await checkGatePrecondition('pr-ready', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});
