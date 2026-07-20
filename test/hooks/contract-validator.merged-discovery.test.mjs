// @ts-check
/**
 * FO-5: the contract-validator hook routes `.devmate/state/discovery-merged.json`
 * (the fan-in's output) through `validateDiscoveryArtifact`, giving the merged
 * artifact the same live PostToolUse validation every other contract artifact
 * gets — one valid and one invalid case, mirroring
 * contract-validator.read-before-assert.test.mjs conventions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runWithIO } from '../../hooks/contract-validator.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

import { markSessionForFile } from '../../lib/test-utils/hook-session.mjs';

// Enforcement is session-scoped (lib/hooks/session-marker.mjs): these tests
// exercise handlers inside an ACTIVE devmate session, so mark one for the
// whole file and stamp its id into each payload.
const TEST_SESSION_ID = markSessionForFile('devmate-test-cv-merged');

/**
 * Build a workspace with a merged discovery artifact.
 * @param {unknown} artifact
 * @returns {Promise<{ root: string, artifactPath: string }>}
 */
async function makeWorkspace(artifact) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'cv-merged-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const artifactPath = join(stateDir, 'discovery-merged.json');
  await fsp.writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
  return { root, artifactPath };
}

/**
 * @param {string} root
 * @param {string} artifactPath
 * @returns {Promise<{ code: number, err: string }>}
 */
async function runHook(root, artifactPath) {
  // #77: the real wire shape. `write_file`, a top-level `path`, and a
  // `workspaceRoot` key are all fictions — VS Code sends `create_file` with
  // `tool_input.filePath`, and anchors the hook with `cwd`.
  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: TEST_SESSION_ID,
    tool_name: 'create_file',
    tool_input: { filePath: artifactPath },
    cwd: root,
  };
  const stdin = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  /** @type {string[]} */
  const errChunks = [];
  const sink = /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ ({
    write: (/** @type {string|Buffer} */ c) => {
      errChunks.push(String(c));
      return true;
    },
  }));
  const code = await runWithIO(stdin, sink, sink);
  return { code, err: errChunks.join('') };
}

test('accepts a valid merged discovery artifact', async () => {
  const { root, artifactPath } = await makeWorkspace({
    agentName: 'discovery',
    claims: [
      {
        fact: 'gate transitions validate against the unified table',
        path: 'lib/gatectl.mjs',
        confidence: 'high',
        corroboration: 2,
        sources: ['discovery-w1', 'discovery-w2'],
      },
    ],
    unverified: ['[UNVERIFIED] retry semantics unclear'],
  });
  const { code, err } = await runHook(root, artifactPath);
  assert.equal(code, 0, `expected pass, stderr: ${err}`);
});

test('rejects an invalid merged discovery artifact and names the contract', async () => {
  const { root, artifactPath } = await makeWorkspace({
    agentName: 'discovery',
    claims: [{ fact: '', path: '', confidence: 'wat' }],
    unverified: ['missing the required tag prefix'],
  });
  const { code, err } = await runHook(root, artifactPath);
  assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
  assert.match(err, /MergedDiscoveryArtifact/, 'violation names the routed contract');
  assert.match(err, /confidence/, 'violation carries the validator errors');
});

test('an invalid merged artifact appends a contract_violation trace event', async () => {
  const { root, artifactPath } = await makeWorkspace({
    agentName: 'discovery',
    taskId: 't-merged',
    claims: 'not-an-array',
    unverified: [],
  });
  const { code } = await runHook(root, artifactPath);
  assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
  const raw = await fsp.readFile(
    join(root, '.devmate', 'state', 'trace', 't-merged.jsonl'),
    'utf8',
  );
  const events = /** @type {any[]} */ (parseJsonl(raw));
  const violation = events.find((e) => e.type === 'contract_violation');
  assert.ok(violation, 'contract_violation event appended');
  assert.equal(violation.contract, 'MergedDiscoveryArtifact');
});
