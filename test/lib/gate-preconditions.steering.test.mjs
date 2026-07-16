// @ts-check
/**
 * E10-05: preconditions for the steering targets — park refuses without a
 * persisted resume pointer, the revise-scope event refuses without a captured
 * scope-change note, and the normal (event-less) paths into existing targets
 * stay unaffected. Temp dirs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESUME_POINTER_FILENAME,
  SCOPE_CHANGE_NOTE_FILENAME,
  checkGatePrecondition,
  readResumePointer,
} from '../../lib/gate-preconditions.mjs';

/** @returns {Promise<string>} a fresh empty state dir */
async function makeStateDir() {
  const root = await mkdtemp(join(tmpdir(), 'gate-pre-steer-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(stateDir, { recursive: true });
  return stateDir;
}

/**
 * Seed the session spec.md the HITL-2 spec-draft gate precondition requires —
 * on the revise-scope path the spec exists mid-implementation by definition.
 * @param {string} stateDir
 * @returns {Promise<void>}
 */
async function seedSpec(stateDir) {
  const sessionDir = join(stateDir, '..', 'session');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'spec.md'), '# Spec\n', 'utf8');
}

/** @returns {Record<string, unknown>} a valid resume pointer */
function validPointer() {
  return {
    taskId: 't-steer',
    gate: 'impl-started',
    parkedAt: new Date().toISOString(),
  };
}

/** @returns {Record<string, unknown>} a valid scope-change note */
function validNote() {
  return {
    taskId: 't-steer',
    note: 'Swap REST polling for websockets.',
    capturedAt: new Date().toISOString(),
  };
}

// ---- parked target precondition ----

test('refuses parked without resume-pointer.json', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('parked', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /resume pointer/);
});

test('allows parked with a valid resume pointer', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, RESUME_POINTER_FILENAME), JSON.stringify(validPointer()), 'utf8');
  const result = await checkGatePrecondition('parked', { stateDir, lane: 'feature' });
  assert.equal(result.ok, true, result.missing.join('; '));
});

test('refuses parked with a malformed resume pointer', async () => {
  const stateDir = await makeStateDir();
  for (const [mutate, expected] of /** @type {Array<[(p: Record<string, unknown>) => void, RegExp]>} */ ([
    [(p) => { p.taskId = ''; }, /taskId/],
    [(p) => { delete p.gate; }, /gate/],
    [(p) => { p.parkedAt = 'not-a-date'; }, /parkedAt/],
  ])) {
    const pointer = validPointer();
    mutate(pointer);
    // @bounded-alloc — writes one fixture pointer per mutation case above.
    await writeFile(join(stateDir, RESUME_POINTER_FILENAME), JSON.stringify(pointer), 'utf8');
    const result = await checkGatePrecondition('parked', { stateDir, lane: 'feature' });
    assert.equal(result.ok, false);
    assert.match(result.missing.join(' '), expected);
  }
});

test('refuses parked when the pointer belongs to another task; accepts a matching one', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, RESUME_POINTER_FILENAME), JSON.stringify(validPointer()), 'utf8');

  const mismatch = await checkGatePrecondition('parked', {
    stateDir,
    lane: 'feature',
    event: 'park',
    taskId: 't-other',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.missing.join(' '), /belongs to task "t-steer"/);

  const match = await checkGatePrecondition('parked', {
    stateDir,
    lane: 'feature',
    event: 'park',
    taskId: 't-steer',
  });
  assert.equal(match.ok, true, match.missing.join('; '));
});

// ---- revise-scope event precondition ----

test('refuses the revise-scope event without scope-change.json', async () => {
  const stateDir = await makeStateDir();
  const result = await checkGatePrecondition('spec-draft', {
    stateDir,
    lane: 'feature',
    event: 'revise-scope',
    taskId: 't-steer',
  });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /scope-change note/);
});

test('allows the revise-scope event with a captured scope-change note', async () => {
  const stateDir = await makeStateDir();
  await seedSpec(stateDir);
  await writeFile(join(stateDir, SCOPE_CHANGE_NOTE_FILENAME), JSON.stringify(validNote()), 'utf8');
  const result = await checkGatePrecondition('spec-draft', {
    stateDir,
    lane: 'feature',
    event: 'revise-scope',
    taskId: 't-steer',
  });
  assert.equal(result.ok, true, result.missing.join('; '));
});

test('refuses the revise-scope event with an empty note or wrong task', async () => {
  const stateDir = await makeStateDir();

  const empty = validNote();
  empty.note = '   ';
  await writeFile(join(stateDir, SCOPE_CHANGE_NOTE_FILENAME), JSON.stringify(empty), 'utf8');
  const emptyResult = await checkGatePrecondition('spec-draft', {
    stateDir,
    lane: 'feature',
    event: 'revise-scope',
  });
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.missing.join(' '), /note must be a non-empty string/);

  await writeFile(join(stateDir, SCOPE_CHANGE_NOTE_FILENAME), JSON.stringify(validNote()), 'utf8');
  const wrongTask = await checkGatePrecondition('spec-draft', {
    stateDir,
    lane: 'feature',
    event: 'revise-scope',
    taskId: 't-other',
  });
  assert.equal(wrongTask.ok, false);
  assert.match(wrongTask.missing.join(' '), /belongs to task "t-steer"/);
});

test('spec-draft without a steering event needs only its own gate precondition (no event leak)', async () => {
  // HITL-2: spec-draft now carries its own gate precondition (a non-empty
  // spec.md), but the revise-scope EVENT requirement still must not leak onto
  // the plain target: with spec.md present and no steering event, entry
  // passes without any scope-change note.
  const stateDir = await makeStateDir();
  await seedSpec(stateDir);
  const result = await checkGatePrecondition('spec-draft', { stateDir, lane: 'feature' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('events without an event-scoped requirement add nothing (resume into impl-started)', async () => {
  // The park/resume/abandon events other than revise-scope attach no extra
  // event requirement, so entering impl-started via resume needs only the
  // gate's own precondition — for a feature task that is the HITL-2 always-on
  // spec-artifact check (satisfied here by the seeded task.json metadata).
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId: 't-steer', lane: 'feature', workflowGate: 'parked',
      artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'steer-digest' },
      preImplStash: null, currentStep: 0, budget: 10, schemaVersion: 1,
    }),
    'utf8',
  );
  const result = await checkGatePrecondition('impl-started', {
    stateDir,
    lane: 'feature',
    event: 'resume',
    taskId: 't-steer',
  });
  assert.equal(result.ok, true);
});

// ---- readResumePointer ----

test('readResumePointer returns the typed pointer for a valid artifact', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, RESUME_POINTER_FILENAME), JSON.stringify(validPointer()), 'utf8');
  const result = await readResumePointer(stateDir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pointer.taskId, 't-steer');
    assert.equal(result.pointer.gate, 'impl-started');
  }
});

test('readResumePointer reports a missing or unparseable artifact', async () => {
  const stateDir = await makeStateDir();
  const missing = await readResumePointer(stateDir);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /not found \(or unparseable\)/);

  await writeFile(join(stateDir, RESUME_POINTER_FILENAME), '{ not json', 'utf8');
  const unparseable = await readResumePointer(stateDir);
  assert.equal(unparseable.ok, false);
});

test('readResumePointer reports structural validation errors', async () => {
  const stateDir = await makeStateDir();
  await writeFile(
    join(stateDir, RESUME_POINTER_FILENAME),
    JSON.stringify({ taskId: 't-steer' }),
    'utf8',
  );
  const result = await readResumePointer(stateDir);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /gate must be a non-empty string/);
    assert.match(result.error, /parkedAt must be an ISO-8601 timestamp/);
  }
});
