// @ts-check
/**
 * FO-5: CLI tests for scripts/merge-discovery.mjs — spawns the real script
 * (mirrors test/scripts/discovery-scan.test.mjs conventions). Covers the
 * happy path (merge + atomic artifact + trace event + digest), the
 * agentName filter, the max_context_sources cap with its fallback, the
 * all-workers-invalid degradation, and the missing-directory IO error.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from '../../lib/json-io.mjs';
import { validateDiscoveryArtifact } from '../../lib/workflow/agents/discovery.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/merge-discovery.mjs', import.meta.url));

/**
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Build a fixture repo root with a worker-returns dir and optional task.json.
 * @param {Record<string, unknown>} workerReturns  filename (no .json) -> artifact.
 * @param {Record<string, unknown>|null} taskState
 * @returns {Promise<string>}
 */
async function buildFixtureRepo(workerReturns, taskState) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'merge-discovery-cli-'));
  const returnsDir = join(root, '.devmate', 'state', 'worker-returns');
  await fsp.mkdir(returnsDir, { recursive: true });
  // @bounded-alloc — writes the handful of fixture files declared by this test case.
  for (const [name, artifact] of Object.entries(workerReturns)) {
    await fsp.writeFile(join(returnsDir, `${name}.json`), JSON.stringify(artifact), 'utf8');
  }
  if (taskState !== null) {
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify(taskState),
      'utf8',
    );
  }
  return root;
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * @param {string} root
 * @param {string} taskId
 * @returns {Promise<any[]>}
 */
async function readTrace(root, taskId) {
  const raw = await fsp.readFile(join(root, '.devmate', 'state', 'trace', `${taskId}.jsonl`), 'utf8');
  return /** @type {any[]} */ (parseJsonl(raw));
}

/**
 * @param {string} fact
 * @param {string} path
 * @returns {{ fact: string, path: string, confidence: 'high'|'low' }}
 */
function claim(fact, path) {
  return { fact, path, confidence: 'high' };
}

test('merge-discovery CLI › merges two workers, writes the artifact atomically, emits the trace event', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': {
        agentName: 'discovery',
        claims: [claim('gates validate transitions', 'lib/gatectl.mjs'), claim('hooks fail closed', 'hooks/gate-guard.mjs')],
        unverified: [],
      },
      'discovery-w2': {
        agentName: 'discovery',
        claims: [claim('gates validate transitions', 'lib/gatectl.mjs'), claim('trace is append-only', 'lib/trace/append.mjs')],
        unverified: ['[UNVERIFIED] retry semantics unclear'],
      },
    },
    { taskId: 'feat-fanout-1', outputContract: { max_context_sources: 10 } },
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0);

    // ≤10-line digest naming kept/collapsed/conflicts/dropped.
    const digestLines = stdout.trim().split('\n');
    assert.ok(digestLines.length <= 10, `digest is ${digestLines.length} lines`);
    assert.match(stdout, /2 input\(s\)/);
    assert.match(stdout, /3 claim\(s\) kept/);
    assert.match(stdout, /1 dup\(s\) collapsed/);

    const artifact = JSON.parse(
      await fsp.readFile(join(root, '.devmate', 'state', 'discovery-merged.json'), 'utf8'),
    );
    assert.equal(artifact.agentName, 'discovery');
    assert.deepEqual(validateDiscoveryArtifact(artifact), { ok: true, errors: [] });
    const corroborated = artifact.claims.find(
      (/** @type {{path: string}} */ c) => c.path === 'lib/gatectl.mjs',
    );
    assert.equal(corroborated.corroboration, 2);
    assert.deepEqual(corroborated.sources.sort(), ['discovery-w1', 'discovery-w2']);
    assert.deepEqual(artifact.unverified, ['[UNVERIFIED] retry semantics unclear']);

    // No stray .tmp file — the atomic rename completed cleanly.
    const stateEntries = await fsp.readdir(join(root, '.devmate', 'state'));
    assert.ok(!stateEntries.some((name) => name.includes('.tmp')), `stray tmp in ${stateEntries}`);

    // discovery_merge trace event with the documented counts.
    const events = await readTrace(root, 'feat-fanout-1');
    const mergeEvent = events.find((e) => e.type === 'discovery_merge');
    assert.ok(mergeEvent, 'discovery_merge event appended');
    assert.equal(mergeEvent.inputs, 2);
    assert.equal(mergeEvent.merged, 3);
    assert.equal(mergeEvent.dropped, 0);
    assert.equal(mergeEvent.conflicts, 0);
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › non-discovery worker returns are filtered out', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': {
        agentName: 'discovery',
        claims: [claim('one fact', 'lib/a.mjs')],
        unverified: [],
      },
      'security-w1': {
        agentName: 'security',
        claims: [claim('should never appear', 'lib/b.mjs')],
        unverified: [],
      },
    },
    { taskId: 'feat-fanout-2', outputContract: { max_context_sources: 10 } },
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /1 input\(s\)/);
    const artifact = JSON.parse(
      await fsp.readFile(join(root, '.devmate', 'state', 'discovery-merged.json'), 'utf8'),
    );
    assert.equal(artifact.claims.length, 1);
    assert.equal(artifact.claims[0].path, 'lib/a.mjs');
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › maxClaims comes from outputContract.max_context_sources', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': {
        agentName: 'discovery',
        claims: [claim('a', 'lib/a.mjs'), claim('b', 'lib/b.mjs'), claim('c', 'lib/c.mjs')],
        unverified: [],
      },
    },
    { taskId: 'feat-fanout-3', outputContract: { max_context_sources: 2 } },
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /2 claim\(s\) kept/);
    assert.match(stdout, /1 dropped/);
    const artifact = JSON.parse(
      await fsp.readFile(join(root, '.devmate', 'state', 'discovery-merged.json'), 'utf8'),
    );
    assert.equal(artifact.claims.length, 2);
    // The capped claim is demoted to a loud unverified entry, never dropped silently.
    assert.ok(
      artifact.unverified.some((/** @type {string} */ u) => u.includes('dropped by merge cap')),
    );
    const events = await readTrace(root, 'feat-fanout-3');
    const mergeEvent = events.find((e) => e.type === 'discovery_merge');
    assert.equal(mergeEvent.dropped, 1);
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › missing task.json: merge succeeds, task-keyed side effects are SKIPPED', skipUnlessNode(24), async () => {
  // Discovery legitimately runs pre-task (before init-task-state). The merge
  // itself must succeed with the maxClaims fallback — but with no real taskId
  // there is nothing to key the trace or the fact ledger on. The old behavior
  // filed both under the literal 'unknown', creating junk files no reader
  // consults; the trace schema now rejects that sentinel outright (#76).
  const claims = Array.from({ length: 12 }, (_, i) => claim(`fact ${i}`, `lib/f${i}.mjs`));
  const root = await buildFixtureRepo(
    { 'discovery-w1': { agentName: 'discovery', claims, unverified: [] } },
    null,
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0, 'a pre-task merge must not fail on the missing trace');
    assert.match(stdout, /10 claim\(s\) kept/);
    assert.match(stdout, /2 dropped/);
    assert.equal(
      existsSync(join(root, '.devmate', 'state', 'trace', 'unknown.jsonl')),
      false,
      'no sentinel-keyed trace file may be created',
    );
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › all workers invalid degrades to an empty merged artifact, exit 0', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': { agentName: 'discovery', claims: 'not-an-array', unverified: [] },
      'discovery-w2': { agentName: 'discovery', claims: [{ fact: '', path: '', confidence: 'wat' }], unverified: [] },
    },
    { taskId: 'feat-fanout-4', outputContract: { max_context_sources: 10 } },
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0, 'invalid inputs are a degradation, not an IO error');
    assert.match(stdout, /0 claim\(s\) kept/);
    assert.match(stdout, /2 invalid input\(s\)/);
    const artifact = JSON.parse(
      await fsp.readFile(join(root, '.devmate', 'state', 'discovery-merged.json'), 'utf8'),
    );
    assert.deepEqual(artifact, { agentName: 'discovery', claims: [], unverified: [] });
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › an unreadable worker-return file is counted, never silently skipped', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    { 'discovery-w1': { agentName: 'discovery', claims: [claim('one fact', 'lib/a.mjs')], unverified: [] } },
    { taskId: 'feat-fanout-5', outputContract: { max_context_sources: 10 } },
  );
  try {
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'worker-returns', 'discovery-corrupt.json'),
      '{ not valid json',
      'utf8',
    );
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'worker-returns', 'not-an-object.json'),
      '[1, 2, 3]',
      'utf8',
    );
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0, 'corruption is surfaced in the digest, not a hard failure');
    assert.match(stdout, /1 input\(s\)/);
    assert.match(stdout, /2 unreadable file\(s\)/);
  } finally {
    await cleanup(root);
  }
});

// ---- FO-6: merged claims are persisted as recallable discovery facts ----

test('merge-discovery CLI › persists merged claims to the task ledger and emits one fact_write event per batch', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': {
        agentName: 'discovery',
        claims: [claim('gate logic lives here', 'lib/gatectl.mjs'), claim('ghost claim', 'lib/ghost.mjs')],
        unverified: [],
      },
    },
    { taskId: 'feat-fanout-6', lane: 'feature', outputContract: { max_context_sources: 10 } },
  );
  try {
    // The referenced file must exist — a claim about a missing file is skipped.
    await fsp.mkdir(join(root, 'lib'), { recursive: true });
    await fsp.writeFile(join(root, 'lib', 'gatectl.mjs'), 'export const g = 1;\n', 'utf8');

    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /facts: 1 written to task ledger/);
    assert.match(stdout, /1 missing source/);

    const ledgerRaw = await fsp.readFile(
      join(root, '.devmate', 'memory', 'tasks', 'feat-fanout-6.jsonl'),
      'utf8',
    );
    const facts = /** @type {any[]} */ (parseJsonl(ledgerRaw)).filter((e) => e.event === 'fact');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].tool, 'discovery-merge');
    assert.equal(facts[0].source, 'lib/gatectl.mjs');
    assert.equal(facts[0].lane, 'feature');
    assert.match(facts[0].contentDigest, /^[0-9a-f]{16}$/);

    // Exactly one fact_write event for the batch, schema-conformant fields.
    const events = await readTrace(root, 'feat-fanout-6');
    const factWrites = events.filter((e) => e.type === 'fact_write');
    assert.equal(factWrites.length, 1);
    assert.equal(factWrites[0].factKey, 'discovery-merge:feat-fanout-6');
    assert.equal(factWrites[0].scope, 'feature');
    assert.equal(factWrites[0].sourcePointer, '.devmate/state/discovery-merged.json');
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › no facts written (all sources missing) → no fact_write event, merge still exits 0', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo(
    {
      'discovery-w1': {
        agentName: 'discovery',
        claims: [claim('nothing on disk', 'lib/missing.mjs')],
        unverified: [],
      },
    },
    { taskId: 'feat-fanout-7', lane: 'feature', outputContract: { max_context_sources: 10 } },
  );
  try {
    const { exitCode, stdout } = run(['--repo-root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /facts: 0 written to task ledger/);
    const events = await readTrace(root, 'feat-fanout-7');
    assert.ok(!events.some((e) => e.type === 'fact_write'), 'no fact_write for an empty batch');
  } finally {
    await cleanup(root);
  }
});

test('merge-discovery CLI › missing worker-returns directory exits 1 with a stderr reason', skipUnlessNode(24), async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'merge-discovery-cli-'));
  try {
    const { exitCode, stderr } = run(['--repo-root', root]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /worker-returns directory not found/);
    // Fail-closed: no merged artifact is written on the error path.
    await assert.rejects(
      fsp.readFile(join(root, '.devmate', 'state', 'discovery-merged.json'), 'utf8'),
    );
  } finally {
    await cleanup(root);
  }
});
