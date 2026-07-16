// @ts-check
/**
 * E9-06: init-task-state persists a real OutputContract (classifyBudget +
 * persistBudget) alongside the legacy integer budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/init-task-state.mjs';
import { readBudget } from '../../lib/context/output-contract.mjs';

/**
 * Run init-task-state main() against a temp state path and return the parsed
 * persisted state.
 * @param {string[]} args
 * @returns {Promise<{ code: number, state: any, statePath: string }>}
 */
async function runInit(args) {
  const dir = await mkdtemp(join(tmpdir(), 'init-oc-'));
  const statePath = join(dir, 'task.json');
  const code = await main(args, statePath);
  /** @type {any} */
  let state = null;
  if (code === 0) {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  }
  return { code, state, statePath };
}

test('init persists an outputContract with tiny class for help lane', async () => {
  const { code, state } = await runInit(['--taskId', 't-help', '--lane', 'help']);
  assert.equal(code, 0);
  assert.equal(state.outputContract.token_budget_class, 'tiny');
  assert.equal(state.outputContract.lane, 'help');
  assert.equal(state.outputContract.citation_mode, 'inline');
});

test('standard for feature lane', async () => {
  const { code, state } = await runInit(['--taskId', 't-feat', '--lane', 'feature', '--description', 'add a widget']);
  assert.equal(code, 0);
  assert.equal(state.outputContract.token_budget_class, 'standard');
  assert.equal(state.outputContract.lane, 'feature');
  assert.equal(state.lane, 'feature');
});

test('large when explicitLarge', async () => {
  const { code, state } = await runInit(['--taskId', 't-big', '--lane', 'feature', '--explicit-large']);
  assert.equal(code, 0);
  assert.equal(state.outputContract.token_budget_class, 'large');
  assert.equal(state.outputContract.max_context_sources, 999);
});

test('readBudget returns the persisted contract', async () => {
  const { code, statePath } = await runInit(['--taskId', 't-read', '--lane', 'bug']);
  assert.equal(code, 0);
  const contract = await readBudget(statePath);
  assert.notEqual(contract, null);
  assert.equal(contract?.token_budget_class, 'standard');
  assert.deepEqual(contract?.evidence_required, ['stack-trace', 'failing-test', 'touched-files']);
});

test('integer budget field is still written', async () => {
  const { code, state } = await runInit(['--taskId', 't-int', '--lane', 'chore', '--budget', '7']);
  assert.equal(code, 0);
  assert.equal(state.budget, 7);
  assert.equal(state.outputContract.token_budget_class, 'standard');
});

test('subagents flag upgrades a tiny lane to standard', async () => {
  const { code, state } = await runInit(['--taskId', 't-sub', '--lane', 'learn', '--subagents']);
  assert.equal(code, 0);
  assert.equal(state.outputContract.token_budget_class, 'standard');
  assert.equal(state.outputContract.lane, 'learn');
});

test('invalid lane is still rejected', async () => {
  const { code } = await runInit(['--taskId', 't-bad', '--lane', 'nonsense']);
  assert.equal(code, 1);
});
