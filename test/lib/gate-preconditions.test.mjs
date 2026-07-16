// @ts-check
/**
 * E9-15: gate-precondition framework — each mapped gate refuses without its
 * artifact, accepts a valid one, unmapped gates pass trivially, and
 * transitionGate refuses an unproven transition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import { transitionGate } from '../../lib/gate-transitions.mjs';

/** @returns {Promise<string>} a fresh empty state dir */
async function makeStateDir() {
  const root = await mkdtemp(join(tmpdir(), 'gate-pre-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(stateDir, { recursive: true });
  return stateDir;
}

/** @returns {Record<string, unknown>} a strict-valid grill artifact */
function validGrill() {
  return {
    taskId: 't-pre',
    mode: 'grill',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    assumptions: [],
    missingRequirements: [],
    edgeCases: [],
    cornerCases: [],
    securityRisks: [],
    uxRisks: [],
    blockingQuestions: [],
    recommendedDecisions: [],
    unverifiedItems: ['[UNVERIFIED] example'],
  };
}

/** @returns {Record<string, unknown>} a strict-valid critique artifact */
function validCritique() {
  return {
    taskId: 't-pre',
    mode: 'critique',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    missingAcceptanceCriteria: [],
    missingTests: [],
    riskySequencing: [],
    unlistedFiles: [],
    backwardsCompatRisks: [],
    rollbackRisk: 'low',
    verdict: 'APPROVE_PLAN',
  };
}

test('refuses lane-set without router-result.json', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('lane-set', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /router result/);
});

test('refuses grill-done without grill-result.json', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('grill-done', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /grill result/);
});

test('refuses grill-done with an invalid grill artifact', async () => {
  const stateDir = await makeStateDir();
  const bad = validGrill();
  bad.unverifiedItems = ['missing the prefix'];
  await writeFile(join(stateDir, 'grill-result.json'), JSON.stringify(bad), 'utf8');
  const result = await checkGatePrecondition('grill-done', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /\[UNVERIFIED\]/);
});

test('refuses plan-done without critique-result.json', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('plan-done', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /critique result/);
});

test('refuses spec-approved without spec.md (precondition invoked)', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('spec-approved', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /spec\.md/, 'checkSpecApprovedPrecondition message surfaces');
});

test('allows spec-approved with spec.md present', async () => {
  const stateDir = await makeStateDir();
  const sessionDir = join(stateDir, '..', 'session');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'spec.md'), '# spec\n', 'utf8');
  const result = await checkGatePrecondition('spec-approved', { stateDir, lane: 'feature' });
  assert.deepEqual(result, { ok: true, missing: [] });
});

test('HITL-2: refuses spec-draft without spec.md, and with an empty spec.md', async () => {
  const stateDir = await makeStateDir();
  const missing = await checkGatePrecondition('spec-draft', { stateDir, lane: 'feature' });
  assert.equal(missing.ok, false);
  assert.match(missing.missing.join(' '), /spec\.md is missing, empty, or unreadable/);
  assert.match(missing.missing.join(' '), /spec-writer/);

  const sessionDir = join(stateDir, '..', 'session');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'spec.md'), '   \n\t\n', 'utf8');
  const empty = await checkGatePrecondition('spec-draft', { stateDir, lane: 'feature' });
  assert.equal(empty.ok, false);
  assert.match(empty.missing.join(' '), /spec\.md is missing, empty, or unreadable/);
});

test('HITL-2: allows spec-draft with a non-empty spec.md', async () => {
  const stateDir = await makeStateDir();
  const sessionDir = join(stateDir, '..', 'session');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'spec.md'), '# Spec\n\n## Acceptance criteria\n- [ ] AC1\n', 'utf8');
  const result = await checkGatePrecondition('spec-draft', { stateDir, lane: 'feature' });
  assert.deepEqual(result, { ok: true, missing: [] });
});

test('HITL-2: feature impl-started fails closed without spec artifact metadata (no config at all)', async () => {
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId: 't-pre', lane: 'feature', workflowGate: 'spec-approved',
      artifactHashes: {}, preImplStash: null, currentStep: 0, budget: 10, schemaVersion: 1,
    }),
    'utf8'
  );
  const result = await checkGatePrecondition('impl-started', { stateDir, lane: 'feature', taskId: 't-pre' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /written and approved spec/);
  assert.match(result.missing.join(' '), /approve spec/);
});

test('HITL-2: feature impl-started fails closed when task.json is missing entirely', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('impl-started', { stateDir, lane: 'feature', taskId: 't-pre' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /written and approved spec/);
});

test('HITL-2: feature impl-started passes with recorded spec metadata; bug/chore unaffected by the spec check', async () => {
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId: 't-pre', lane: 'feature', workflowGate: 'spec-approved',
      artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc123' },
      preImplStash: null, currentStep: 0, budget: 10, schemaVersion: 1,
    }),
    'utf8'
  );
  const feature = await checkGatePrecondition('impl-started', { stateDir, lane: 'feature', taskId: 't-pre' });
  assert.deepEqual(feature, { ok: true, missing: [] });

  // Same stateDir, no metadata needed for the other lanes: the always-on spec
  // check is feature-only (bug/chore artifacts are dispatch-time checks).
  for (const lane of ['bug', 'chore']) {
    const result = await checkGatePrecondition('impl-started', { stateDir, lane });
    assert.deepEqual(result, { ok: true, missing: [] }, `${lane} must not require spec metadata`);
  }
});

test('allows grill-done and plan-done with valid artifacts', async () => {
  // The ctx carries taskId because the real caller does: `transitionGate` passes
  // `taskId: state.taskId` on every transition. An artifact must now belong to the
  // task asking for it, so a ctx without one is a shape no production path builds.
  const stateDir = await makeStateDir();
  const ctx = { stateDir, lane: 'feature', taskId: 't-pre' };
  await writeFile(join(stateDir, 'grill-result.json'), JSON.stringify(validGrill()), 'utf8');
  await writeFile(join(stateDir, 'critique-result.json'), JSON.stringify(validCritique()), 'utf8');
  assert.equal((await checkGatePrecondition('grill-done', ctx)).ok, true);
  assert.equal((await checkGatePrecondition('plan-done', ctx)).ok, true);
});

test('refuses a grill result left behind by a DIFFERENT task', async () => {
  // Nothing deletes `.devmate/state/*.json` between tasks, and the gate used to ask
  // only "does a well-formed grill-result.json exist?" — a question last week's
  // artifact answers perfectly. The lane would then walk past its own grill on
  // evidence about a different bug entirely.
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, 'grill-result.json'),
    JSON.stringify({ ...validGrill(), taskId: 'some-older-task' }),
    'utf8',
  );

  const result = await checkGatePrecondition('grill-done', {
    stateDir,
    lane: 'feature',
    taskId: 't-pre',
  });

  assert.equal(result.ok, false, 'a grill result from another task was accepted as this task’s evidence');
  assert.match(result.missing.join(' '), /stale evidence|belongs to task/i);
});

test('allows lane-set with a valid, confident router result (E9-10)', async () => {
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, 'router-result.json'),
    JSON.stringify({ lane: 'feature', budgetClass: 'standard', confidence: 0.9 }),
    'utf8'
  );
  assert.equal((await checkGatePrecondition('lane-set', { stateDir, lane: 'feature' })).ok, true);
});

test('unmapped gate passes trivially', async () => {
  const stateDir = await makeStateDir();
  // pr-ready is now mapped (AC-2, epic #416) but still passes trivially here
  // with no devmate.config.json present: loadDevmateConfig fails, so
  // acCoverageGate defaults to 'off' — a complete no-op, same observable
  // result as an unmapped gate. See test/lib/gate-preconditions.ac-coverage.test.mjs
  // for the mapped behavior once acCoverageGate is configured.
  for (const gate of ['done', 'impl-started', 'pr-ready', 'no-lane']) {
    const result = await checkGatePrecondition(gate, { stateDir, lane: 'chore' });
    assert.deepEqual(result, { ok: true, missing: [] }, `${gate} passes trivially`);
  }
});

test('transitionGate refuses an unproven transition with missing details', async () => {
  const state = /** @type {any} */ ({
    taskId: 't-pre',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 1,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
  });
  const refusing = async () => ({ ok: false, missing: ['verify evidence missing'] });
  const result = await transitionGate(state, 'pass-verification', { checkPrecondition: refusing });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Gate precondition failed for "verification-passed"/);
  assert.match(result.error ?? '', /verify evidence missing/);
});

test('transitionGate passes preconditions through the real framework', async () => {
  const stateDir = await makeStateDir();
  const state = /** @type {any} */ ({
    taskId: 't-pre',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 1,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
  });
  // verification-passed is mapped (E9-13): refused without evidence…
  const refused = await transitionGate(state, 'pass-verification', { stateDir });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /verify evidence/);
  // …and allowed with a fresh passing artifact.
  await writeFile(
    join(stateDir, 'verify-result.json'),
    JSON.stringify({
      passed: true,
      digest: 'ok',
      fullOutputPath: '/tmp/full.log',
      completedAt: new Date().toISOString(),
      specDigest: '',
    }),
    'utf8'
  );
  const allowed = await transitionGate(state, 'pass-verification', { stateDir });
  assert.equal(allowed.ok, true);
});
