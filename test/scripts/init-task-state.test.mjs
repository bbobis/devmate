// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/init-task-state.mjs';

test('init-task-state main() — valid args → returns 0 and writes parseable file', async () => {
  const dir = join(tmpdir(), `devmate-init-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');

  const code = await main(['--taskId', 'my-feature', '--lane', 'feature', '--budget', '5'], filePath);
  assert.equal(code, 0);

  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(parsed.taskId, 'my-feature');
  assert.equal(parsed.lane, 'feature');
  // #91: this asserted `plan-approved` — an ALREADY-OPEN implementation gate on
  // a task no human had seen. It was also the only thing in the repo that could
  // produce that gate value, which is the only reason the bug and chore lanes
  // could reach impl-started at all. The gates now advance on evidence, so
  // nothing needs a pre-opened gate, and this seeds the same pre-router gate
  // SessionStart does.
  assert.equal(parsed.workflowGate, 'no-lane');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.budget, 5);

  rmSync(dir, { recursive: true });
});

test('init-task-state main() — missing --taskId → returns 1', async () => {
  const dir = join(tmpdir(), `devmate-init-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');

  const code = await main(['--lane', 'feature'], filePath);
  assert.equal(code, 1);

  rmSync(dir, { recursive: true });
});

test('init-task-state main() — invalid --taskId is rejected at creation (fail-closed)', async () => {
  const dir = join(tmpdir(), `devmate-init-test-${Date.now()}-bad`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');

  // Ids that are accepted by TaskState (non-empty string) but fail TASK_ID_RE
  // and would otherwise silently disable memory writes for the whole task.
  for (const badId of ['E10-4', 'Fix Login', 'feat/nested', 'UPPER']) {
    const code = await main(['--taskId', badId, '--lane', 'feature'], filePath);
    assert.equal(code, 2, `expected exit 2 for taskId ${JSON.stringify(badId)}`);
  }
  // No state file is ever written for a rejected id.
  assert.equal(existsSync(filePath), false);

  rmSync(dir, { recursive: true });
});

test('init-task-state main() — stdout contains plan_stored_at JSON field', async () => {
  const dir = join(tmpdir(), `devmate-init-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');

  // Capture stdout
  const originalWrite = process.stdout.write.bind(process.stdout);
  /** @type {string[]} */
  const captured = [];
  // @ts-ignore — intentional override for test capture
  process.stdout.write = (/** @type {string|Buffer} */ chunk, ..._rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };

  try {
    const code = await main(['--taskId', 't1', '--lane', 'feature'], filePath);
    assert.equal(code, 0);

    const combined = captured.join('');
    // Extract the emitted JSON object by shape rather than by line: the
    // node:test runner interleaves its own frames on stdout in-process, so
    // line-splitting is not reliable.
    const jsonMatch = combined.match(/\{"ok":true,"plan_stored_at":"[^"]+","handoff_dir":"[^"]+"\}/);
    const planLine = jsonMatch ? JSON.parse(jsonMatch[0]) : undefined;

    assert.ok(planLine, `expected a JSON line with plan_stored_at, got: ${combined}`);
    assert.equal(planLine.ok, true);
    assert.ok(planLine.plan_stored_at.endsWith('task.json'), `plan_stored_at should end with task.json, got: ${planLine.plan_stored_at}`);
    assert.ok(typeof planLine.handoff_dir === 'string', 'handoff_dir should be a string');
  } finally {
    process.stdout.write = originalWrite;
    rmSync(dir, { recursive: true });
  }
});
