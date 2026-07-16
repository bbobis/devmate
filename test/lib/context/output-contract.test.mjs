// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyBudget,
  persistBudget,
  readBudget,
  StateReadError,
} from '../../../lib/context/output-contract.mjs';

/**
 * @param {string} [content]
 * @returns {Promise<string>}
 */
async function mkStateFile(content) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'output-contract-'));
  const path = join(dir, 'task.json');
  if (content !== undefined) await fsp.writeFile(path, content, 'utf8');
  return path;
}

const validState = JSON.stringify({
  taskId: 't1',
  lane: 'feature',
  workflowGate: 'plan-approved',
  artifactHashes: {},
  preImplStash: null,
  currentStep: 0,
  budget: 10,
  schemaVersion: 1,
});

test('classifyBudget — lane=help → tiny, max 3 sources, inline citation', () => {
  const c = classifyBudget({ lane: 'help', description: 'q' });
  assert.equal(c.token_budget_class, 'tiny');
  assert.equal(c.max_context_sources, 3);
  assert.equal(c.citation_mode, 'inline');
});

test('classifyBudget — lane=bug → standard, evidence includes stack-trace', () => {
  const c = classifyBudget({ lane: 'bug', description: 'crash' });
  assert.equal(c.token_budget_class, 'standard');
  assert.ok(c.evidence_required.includes('stack-trace'));
  assert.ok(c.evidence_required.includes('failing-test'));
});

test('classifyBudget — lane=feature → standard, citation_mode=pointer', () => {
  const c = classifyBudget({ lane: 'feature', description: 'add x' });
  assert.equal(c.token_budget_class, 'standard');
  assert.equal(c.citation_mode, 'pointer');
});

test('classifyBudget — explicitLarge=true → large regardless of lane', () => {
  const c = classifyBudget({ lane: 'help', description: 'q', explicitLarge: true });
  assert.equal(c.token_budget_class, 'large');
  assert.equal(c.max_context_sources, 999);
});

test('classifyBudget — subagents=true + lane=help → standard (override tiny)', () => {
  const c = classifyBudget({ lane: 'help', description: 'q', subagents: true });
  assert.equal(c.token_budget_class, 'standard');
  assert.equal(c.max_context_sources, 10);
});

test('classifyBudget — pure: same input → same output (minus timestamp)', () => {
  const a = classifyBudget({ lane: 'feature', description: 'd' });
  const b = classifyBudget({ lane: 'feature', description: 'd' });
  const stripA = { ...a, created_at: '' };
  const stripB = { ...b, created_at: '' };
  assert.deepEqual(stripA, stripB);
});

test('persistBudget — writes contract into TaskState atomically', async () => {
  const path = await mkStateFile(validState);
  const c = classifyBudget({ lane: 'feature', description: 'd' });
  await persistBudget(path, c);
  const written = JSON.parse(await fsp.readFile(path, 'utf8'));
  assert.deepEqual(written.outputContract, c);
  // Original fields preserved.
  assert.equal(written.taskId, 't1');
  assert.equal(written.schemaVersion, 1);
  // No leftover temp file.
  await assert.rejects(fsp.stat(path + '.tmp'), /ENOENT/);
});

test('persistBudget — throws typed error on malformed JSON, does not truncate', async () => {
  const broken = '{ not valid json';
  const path = await mkStateFile(broken);
  const c = classifyBudget({ lane: 'feature', description: 'd' });
  await assert.rejects(persistBudget(path, c), StateReadError);
  // File untouched.
  assert.equal(await fsp.readFile(path, 'utf8'), broken);
});

test('persistBudget — throws on missing schemaVersion', async () => {
  const noVersion = JSON.stringify({ taskId: 't1', lane: 'feature' });
  const path = await mkStateFile(noVersion);
  const c = classifyBudget({ lane: 'feature', description: 'd' });
  await assert.rejects(persistBudget(path, c), /schemaVersion/);
});

test('readBudget — returns null when outputContract absent', async () => {
  const path = await mkStateFile(validState);
  assert.equal(await readBudget(path), null);
});

test('readBudget — returns contract after persistBudget round-trip', async () => {
  const path = await mkStateFile(validState);
  const c = classifyBudget({ lane: 'bug', description: 'd' });
  await persistBudget(path, c);
  const got = await readBudget(path);
  assert.deepEqual(got, c);
});
