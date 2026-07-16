// @ts-check

/**
 * Opt-in runtime delegation floor at the impl-started gate precondition.
 * Default OFF (no config flag) is a no-op; ON refuses to start implementation
 * unless the lane's read-heavy analysis was delegated (a subagent_start trace
 * event exists for each required specialist group).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

/**
 * @param {string} a
 * @returns {Record<string, unknown>}
 */
function startEvent(a) {
  return {
    type: 'subagent_start',
    stepId: `subagent-${a}`,
    taskId: 't',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    agentName: a,
    persona: a,
    activeCount: 1,
  };
}

/**
 * @param {{ enforce?: boolean, mode?: string, requirements?: Record<string, unknown>, trace?: Array<Record<string, unknown>>, taskId?: string, lane?: string, specMeta?: boolean }} [opts]
 */
function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'impl-floor-'));
  const devmate = join(root, '.devmate');
  const stateDir = join(devmate, 'state');
  mkdirSync(join(stateDir, 'trace'), { recursive: true });

  /** @type {Record<string, unknown>} */
  const config = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['**'] }] };
  if (opts.enforce !== undefined) config.enforceDelegationFloor = opts.enforce;
  if (opts.mode !== undefined) config.delegationFloor = opts.mode;
  if (opts.requirements !== undefined) config.delegationFloorRequirements = opts.requirements;
  writeFileSync(join(devmate, 'devmate.config.json'), JSON.stringify(config), 'utf8');

  const taskId = opts.taskId ?? 't';
  // HITL-2: the always-on feature spec-artifact check runs before the floor,
  // so floor tests seed recorded spec metadata by default (specMeta: false
  // exercises the always-on check itself).
  const artifactHashes = opts.specMeta === false
    ? {}
    : { spec: '.devmate/session/spec.md', specDigest: 'floor-digest' };
  writeFileSync(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId,
      lane: opts.lane ?? 'feature',
      workflowGate: 'spec-approved',
      artifactHashes,
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  if (opts.trace) {
    writeFileSync(
      join(stateDir, 'trace', `${taskId}.jsonl`),
      opts.trace.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }
  return { root, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('HITL-2 / feature without spec metadata is blocked under EVERY floor mode (always-on, not mode-gated)', async () => {
  for (const mode of [undefined, 'warn', 'block']) {
    const fx = makeFixture({
      specMeta: false,
      ...(mode === undefined ? {} : { mode }),
      trace: [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner')],
    });
    try {
      const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
      assert.equal(r.ok, false, `mode ${mode ?? 'off (default)'} must not bypass the spec check`);
      assert.match(r.missing.join(' '), /written and approved spec/);
    } finally {
      fx.cleanup();
    }
  }
});

test('HITL-2 / bug and chore without spec metadata are unaffected by the always-on spec check', async () => {
  for (const lane of ['bug', 'chore']) {
    const fx = makeFixture({ specMeta: false, lane });
    try {
      const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane, taskId: 't' });
      assert.equal(r.ok, true, `${lane} must pass with default floor and no spec metadata`);
    } finally {
      fx.cleanup();
    }
  }
});

test('impl floor / default off (no flag) → ok even with no dispatches', async () => {
  const fx = makeFixture({});
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / off explicitly → ok', async () => {
  const fx = makeFixture({ enforce: false });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + feature + no dispatch → blocked', async () => {
  const fx = makeFixture({ enforce: true });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /delegation floor/);
    assert.match(r.missing.join(' '), /discovery/);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + feature + full analysis trace → ok', async () => {
  const fx = makeFixture({
    enforce: true,
    trace: [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner')],
  });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + feature satisfied by tech-design (any-of) but missing planner → blocked', async () => {
  const fx = makeFixture({ enforce: true, trace: [startEvent('tech-design'), startEvent('rubber-duck')] });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /planner/);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + chore → ok (no analysis phase)', async () => {
  const fx = makeFixture({ enforce: true, lane: 'chore' });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'chore', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + bug + only diagnose → blocked (missing rubber-duck)', async () => {
  const fx = makeFixture({ enforce: true, lane: 'bug', trace: [startEvent('diagnose')] });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'bug', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /rubber-duck/);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / on + taskId resolved from task.json when ctx.taskId absent', async () => {
  const fx = makeFixture({
    enforce: true,
    taskId: 'feat-9',
    trace: [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner')],
  });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / warn mode → allows the transition but records a contract_violation', async () => {
  const fx = makeFixture({ mode: 'warn' }); // feature lane, no analysis dispatched
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true, 'warn mode must not block the transition');

    const lines = /** @type {any[]} */ (parseJsonl(readFileSync(join(fx.stateDir, 'trace', 't.jsonl'), 'utf8')));
    const violation = lines.find(
      (e) => e.type === 'contract_violation' && e.contract === 'delegation-floor',
    );
    assert.ok(violation, 'warn mode must record a delegation-floor contract_violation event');
    assert.ok(Array.isArray(violation.errors) && violation.errors.length > 0);
    assert.equal(violation.path, 'feature/impl-started');
  } finally {
    fx.cleanup();
  }
});

test('impl floor / warn mode with full analysis records nothing and allows', async () => {
  const fx = makeFixture({
    mode: 'warn',
    trace: [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner')],
  });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
    const lines = /** @type {any[]} */ (parseJsonl(readFileSync(join(fx.stateDir, 'trace', 't.jsonl'), 'utf8')));
    assert.equal(lines.some((e) => e.type === 'contract_violation'), false);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / delegationFloor:block refuses like the legacy boolean', async () => {
  const fx = makeFixture({ mode: 'block' });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / legacy enforceDelegationFloor:true maps to block', async () => {
  const fx = makeFixture({ enforce: true });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / per-lane requirements override can relax the floor', async () => {
  // Override requires only discovery for feature; discovery ran → ok even
  // without the default rubber-duck/planner.
  const fx = makeFixture({ mode: 'block', requirements: { feature: [['discovery']] }, trace: [startEvent('discovery')] });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('impl floor / per-lane requirements override can tighten the floor', async () => {
  const fx = makeFixture({ mode: 'block', requirements: { feature: [['security']] } });
  try {
    const r = await checkGatePrecondition('impl-started', { stateDir: fx.stateDir, lane: 'feature', taskId: 't' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /security/);
  } finally {
    fx.cleanup();
  }
});
