// @ts-check
/**
 * E9-16: SessionStart auto-computes the resume plan when a task is in
 * progress, is a silent no-op on fresh sessions, and falls back to
 * confirm_needed on a malformed trace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runWithIO } from '../../scripts/session-start.mjs';

/**
 * Build a minimal, devmate-ready repo root so the readiness checks pass.
 * @param {{ withTask?: boolean, traceLines?: string[] }} opts
 * @returns {Promise<string>}
 */
async function makeRepoRoot(opts = {}) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ss-resume-'));
  await fsp.mkdir(join(root, '.git'), { recursive: true });
  await fsp.mkdir(join(root, '.devmate', 'state', 'trace'), { recursive: true });
  await fsp.writeFile(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'fullstack', editableGlobs: ['src/**'] }],
      verification: { unitTest: 'node --test' },
    }),
    'utf8'
  );
  // No hooks/ or scripts/ here: the gate-guard manifest and script are
  // plugin-shipped and resolve against the plugin root, not this repo (#72).
  if (opts.withTask) {
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId: 't-resume',
        lane: 'feature',
        workflowGate: 'impl-started',
        currentStep: 0,
        artifactHashes: {},
        preImplStash: null,
        budget: 10,
        schemaVersion: 1,
      }),
      'utf8'
    );
  }
  if (opts.traceLines) {
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'trace', 't-resume.jsonl'),
      opts.traceLines.join('\n') + '\n',
      'utf8'
    );
  }
  return root;
}

/**
 * @param {string} root
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function runSessionStart(root) {
  const stdin = Readable.from([
    Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }), 'utf8'),
  ]);
  /** @type {string[]} */
  const outChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  const mkStream = (/** @type {string[]} */ sink) =>
    /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ ({
      write: (/** @type {string|Buffer} */ c) => {
        sink.push(String(c));
        return true;
      },
    }));
  const code = await runWithIO(stdin, mkStream(outChunks), mkStream(errChunks));
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

/**
 * @param {string} root
 * @returns {Promise<any|null>}
 */
async function readPlan(root) {
  try {
    return JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'resume-plan.json'), 'utf8'));
  } catch {
    return null;
  }
}

test('emits resume plan when task state exists', async () => {
  const root = await makeRepoRoot({ withTask: true });
  const { code, out } = await runSessionStart(root);
  assert.equal(code, 0);
  const plan = await readPlan(root);
  assert.notEqual(plan, null, 'resume-plan.json written');
  assert.equal(plan.taskId, 't-resume');
  assert.ok(
    ['proceed', 'confirm_needed', 'blocked_halt', 'already_complete'].includes(plan.action),
    `plan action valid: ${plan.action}`
  );
  assert.match(out, /resumeAction/, 'plan line printed');
});

test('no-op on fresh session', async () => {
  const root = await makeRepoRoot({ withTask: false });
  const { code, out } = await runSessionStart(root);
  assert.equal(code, 0);
  assert.equal(await readPlan(root), null, 'no resume-plan.json on fresh session');
  assert.ok(!out.includes('resumeAction'), 'no plan line on fresh session');
});

test('malformed trace yields confirm_needed', async () => {
  const root = await makeRepoRoot({
    withTask: true,
    traceLines: [
      JSON.stringify({
        taskId: 't-resume',
        stepId: 's1',
        ts: '2026-06-24T10:00:00.000Z',
        schemaVersion: 1,
        type: 'action',
        actionType: 'write',
        path: 'a.mjs',
        digest: 'abc0000000000000',
      }),
      '{ this is not json !!',
    ],
  });
  const { code } = await runSessionStart(root);
  assert.equal(code, 0, 'never crashes the session');
  const plan = await readPlan(root);
  assert.notEqual(plan, null);
  assert.equal(plan.action, 'confirm_needed');
});

test('writes resume-plan.json atomically', async () => {
  const root = await makeRepoRoot({ withTask: true });
  await runSessionStart(root);
  // Atomic tmp+rename leaves no *.tmp siblings behind.
  const entries = await fsp.readdir(join(root, '.devmate', 'state'));
  assert.ok(entries.includes('resume-plan.json'));
  assert.deepEqual(entries.filter((e) => e.endsWith('.tmp')), []);
});
