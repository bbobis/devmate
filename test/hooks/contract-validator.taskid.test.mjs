// @ts-check
/**
 * #76 (#81 review) — the violation-trace taskId is a FILENAME built from
 * untrusted input.
 *
 * A worker-return artifact is model-written. Its `taskId` flows into
 * `traceFilePath`, which path-joins `${taskId}.jsonl` — so an id carrying
 * separators or `..` would write outside `.devmate/state/trace/`. Only ids
 * matching the canonical filesystem-safe TASK_ID_RE may reach the join;
 * anything else falls back to task.json's id, then to skipping the trace.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'contract-validator.mjs');

/**
 * Seed a workspace with a malformed worker-return artifact whose taskId is
 * attacker-shaped, then run the validator against it.
 * @param {string} claimedTaskId
 */
function runWithClaimedTaskId(claimedTaskId) {
  const root = mkdtempSync(join(tmpdir(), 'cv-taskid-'));
  const returnsDir = join(root, '.devmate', 'state', 'worker-returns');
  mkdirSync(returnsDir, { recursive: true });
  const artifactPath = join(returnsDir, 'w1.json');
  // Shape-invalid on purpose (missing required fields) so the validator takes
  // the violation path — which is where the taskId becomes a filename.
  writeFileSync(
    artifactPath,
    JSON.stringify({ taskId: claimedTaskId, agentName: 'discovery' }),
    'utf8',
  );
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'create_file',
      // #77: VS Code names the write target `tool_input.filePath`. This test used
      // a top-level `path` — the very key that made the validator a no-op — so it
      // was exercising a route production never takes.
      tool_input: { filePath: artifactPath },
      cwd: root,
    }),
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { root, r };
}

test(
  'a path-traversal taskId in a worker artifact cannot escape the trace dir',
  skipUnlessNode(24),
  () => {
    const evil = '../../escaped';
    const { root, r } = runWithClaimedTaskId(evil);
    try {
      assert.equal(r.status, 2, 'exit 2 is the only non-zero code VS Code treats as blocking (#77)');
      // The traversal target must not exist anywhere it would land.
      assert.equal(existsSync(join(root, '.devmate', 'escaped.jsonl')), false);
      assert.equal(existsSync(join(root, 'escaped.jsonl')), false);
      assert.equal(
        existsSync(join(root, '.devmate', 'state', 'trace', 'escaped.jsonl')),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('a well-formed artifact taskId is still used for the violation trace', skipUnlessNode(24), () => {
  const { root, r } = runWithClaimedTaskId('feat-legit-1');
  try {
    assert.equal(r.status, 2);
    assert.ok(
      existsSync(join(root, '.devmate', 'state', 'trace', 'feat-legit-1.jsonl')),
      'a canonical id keys the trace as before',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
