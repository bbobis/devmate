// @ts-check
/**
 * E9-18: read-before-assert — the contract-validator hook rejects artifacts
 * citing file pointers that do not resolve to a real, in-range slice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runWithIO } from '../../hooks/contract-validator.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';
import { verifyPointer } from '../../lib/context/evidence-pack.mjs';

/**
 * Build a workspace with a grill artifact carrying the given pointers.
 * @param {Array<Record<string, unknown>>} pointers
 * @returns {Promise<{ root: string, artifactPath: string }>}
 */
async function makeWorkspace(pointers) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'rba-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  // A real 5-line source file pointers can cite.
  await fsp.mkdir(join(root, 'src'), { recursive: true });
  await fsp.writeFile(join(root, 'src', 'real.mjs'), 'a\nb\nc\nd\ne\n', 'utf8');

  const artifact = {
    taskId: 't-rba',
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
    unverifiedItems: [],
    evidencePointers: pointers,
  };
  const artifactPath = join(stateDir, 'grill-result.json');
  await fsp.writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
  return { root, artifactPath };
}

/**
 * @param {string} root
 * @param {string} artifactPath
 * @returns {Promise<{ code: number, err: string }>}
 */
async function runHook(root, artifactPath) {
  // #77: the real wire shape — `create_file` + `tool_input.filePath` + `cwd`.
  const payload = {
    hook_event_name: 'PostToolUse',
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

/**
 * @param {string} root
 * @returns {Promise<any[]>}
 */
async function readTraceEvents(root) {
  try {
    const raw = await fsp.readFile(join(root, '.devmate', 'state', 'trace', 't-rba.jsonl'), 'utf8');
    return parseJsonl(raw);
  } catch {
    return [];
  }
}

test('rejects pointer to nonexistent file', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'src/does-not-exist.mjs', lineRange: [1, 3], kind: 'file' },
  ]);
  const { code, err } = await runHook(root, artifactPath);
  assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
  assert.match(err, /does-not-exist\.mjs/, 'offending pointer named');
  assert.match(err, /read-before-assert/);
});

test('rejects out-of-range lineRange', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'src/real.mjs', lineRange: [4, 99], kind: 'file' },
  ]);
  const { code, err } = await runHook(root, artifactPath);
  assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
  assert.match(err, /out of bounds/);
});

test('accepts valid in-range pointer', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'src/real.mjs', lineRange: [2, 4], kind: 'file' },
  ]);
  const { code } = await runHook(root, artifactPath);
  assert.equal(code, 0);
});

test('accepts whole-file pointer to existing file', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'src/real.mjs', lineRange: null, kind: 'file' },
  ]);
  const { code } = await runHook(root, artifactPath);
  assert.equal(code, 0);
});

test('non-file pointer kinds are skipped', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'https://example.com/docs', lineRange: null, kind: 'url' },
  ]);
  const { code } = await runHook(root, artifactPath);
  assert.equal(code, 0);
});

test('emits contract_violation on failure', async () => {
  const { root, artifactPath } = await makeWorkspace([
    { path: 'src/missing.mjs', lineRange: [1, 2], kind: 'file' },
  ]);
  const { code } = await runHook(root, artifactPath);
  assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
  const events = await readTraceEvents(root);
  const violation = events.find((e) => e.type === 'contract_violation');
  assert.ok(violation, 'contract_violation event appended');
  assert.equal(violation.contract, 'GrillResult');
  assert.ok(
    violation.errors.some((/** @type {string} */ e) => e.includes('src/missing.mjs')),
    'violation names the bad pointer'
  );
});

test('verifyPointer returns typed results without throwing', async () => {
  const missing = await verifyPointer(
    /** @type {any} */ ({
      path: join(tmpdir(), 'definitely-missing-file.mjs'),
      lineRange: null,
      reason: 'x',
      confidence: 1,
      freshness: new Date().toISOString(),
      kind: 'file',
    })
  );
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.error, 'string');
});
