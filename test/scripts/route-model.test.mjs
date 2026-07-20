// @ts-check
/**
 * E9-11: route-model dispatch wiring — advisory routing on placeholder
 * policies, baseline-gated honoring of verified IDs, and trace recording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/route-model.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';
import { routeModel } from '../../lib/routing/model-policy.mjs';
import { assertRouteAllowed } from '../../lib/routing/policy-guard.mjs';

const PLACEHOLDER_POLICY = {
  schemaVersion: 1,
  byBudgetClass: {
    tiny: { modelId: '[UNVERIFIED — tiny]', verifiedAt: null },
    standard: { modelId: '[UNVERIFIED — standard]', verifiedAt: null },
    large: { modelId: '[UNVERIFIED — large]', verifiedAt: null },
  },
};

const VERIFIED_POLICY = {
  schemaVersion: 1,
  byBudgetClass: {
    tiny: { modelId: 'real-tiny-model', verifiedAt: '2026-07-01', source: 'https://docs.example/models' },
    standard: { modelId: 'real-standard-model', verifiedAt: '2026-07-01', source: 'https://docs.example/models' },
    large: { modelId: 'real-large-model', verifiedAt: '2026-07-01', source: 'https://docs.example/models' },
  },
};

/** Silence stdio during a run. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/**
 * @param {string[]} args
 * @param {Parameters<typeof main>[1]} opts
 * @returns {Promise<{ code: number, out: string }>}
 */
async function run(args, opts) {
  /** @type {string[]} */
  const chunks = [];
  const capture = /** @type {typeof process.stdout.write} */ ((c) => {
    chunks.push(String(c));
    return true;
  });
  process.stdout.write = capture;
  process.stderr.write = capture;
  let code;
  try {
    code = await main(args, opts);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join('') };
}

/**
 * @param {{ budgetClass?: string, policy?: unknown, withBaselines?: boolean, acceptanceCriteria?: string[], planAc?: string[] }} opts
 * @returns {Promise<{ root: string, taskStatePath: string, policyPath: string, evalsDir: string }>}
 */
async function makeWorkspace(opts = {}) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'route-model-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const taskStatePath = join(stateDir, 'task.json');
  // #217: seed the APPROVED PLAN artifact (present at route-model's plan-approved
  // invocation) as the real AC signal — the production path route-model reads,
  // not the spec's state.acceptanceCriteria, which does not exist yet at that gate.
  if (opts.planAc) {
    const planDir = join(root, '.devmate', 'session', 't-route');
    await fsp.mkdir(planDir, { recursive: true });
    await fsp.writeFile(
      join(planDir, 'plan.json'),
      JSON.stringify({
        tasks: [{ description: 'impl', ac: opts.planAc, tddApproach: 'unit', persona: 'backend', files: ['x.mjs'] }],
        assumptions: [],
        openRisks: [],
        unverified: [],
      }),
      'utf8'
    );
  }
  await fsp.writeFile(
    taskStatePath,
    JSON.stringify({
      taskId: 't-route',
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
      ...(opts.acceptanceCriteria ? { acceptanceCriteria: opts.acceptanceCriteria } : {}),
      outputContract: {
        lane: 'feature',
        format: 'pr',
        audience: 'orchestrator',
        done_when: 'x',
        evidence_required: [],
        citation_mode: 'pointer',
        token_budget_class: opts.budgetClass ?? 'tiny',
        max_context_sources: 3,
        created_at: new Date().toISOString(),
      },
    }),
    'utf8'
  );
  const policyPath = join(root, 'model-policy.json');
  await fsp.writeFile(policyPath, JSON.stringify(opts.policy ?? PLACEHOLDER_POLICY), 'utf8');
  const evalsDir = join(root, 'evals');
  if (opts.withBaselines) {
    await fsp.mkdir(join(evalsDir, 'model-routing'), { recursive: true });
    // @bounded-alloc — writes three baseline fixtures.
    for (const cls of ['tiny', 'standard', 'large']) {
      await fsp.writeFile(
        join(evalsDir, 'model-routing', `baseline-${cls}.json`),
        JSON.stringify({ budgetClass: cls, recordedAt: new Date().toISOString(), taskSetHash: 'x', taskCount: 1, metrics: { costUsd: 0, qualityScore: 0 } }),
        'utf8'
      );
    }
  }
  return { root, taskStatePath, policyPath, evalsDir };
}

test('advisory recommendation for unverified policy does not throw', async () => {
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace();
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0, out);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.budgetClass, 'tiny');
  assert.equal(hint.mode, 'advisory');
  assert.equal(hint.verified, false);
  assert.match(hint.modelId, /UNVERIFIED/);
  // #27: the advisory hint carries a cheap/powerful cost tier with a reason.
  assert.equal(hint.tier, 'cheap');
  assert.equal(typeof hint.tierReason, 'string');
  assert.ok(hint.tierReason.length > 0);
});

test('#27: a large budget class yields a powerful tier on the advisory hint', async () => {
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ budgetClass: 'large' });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0, out);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.budgetClass, 'large');
  assert.equal(hint.tier, 'powerful');
  assert.match(hint.tierReason, /large budget class/);
});

test('#217: a standard class with a many-AC approved plan escalates to a powerful tier', async () => {
  // 6 ACs in the approved plan → difficulty 0.75 ≥ threshold → powerful, driven by
  // the plan's AC count (the real artifact at plan-approved), not the budget class.
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({
    budgetClass: 'standard',
    planAc: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0, out);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.budgetClass, 'standard');
  assert.equal(hint.tier, 'powerful');
});

test('#217: a standard class with a few-AC approved plan stays cheap', async () => {
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({
    budgetClass: 'standard',
    planAc: ['a', 'b'],
  });
  const { code } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.tier, 'cheap');
});

test('#217: with no plan, the spec acceptanceCriteria on state is the fallback signal', async () => {
  // A later invocation (post-spec) has no plan.json here but does have the spec's
  // acceptance criteria on state — the fallback path still escalates.
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({
    budgetClass: 'standard',
    acceptanceCriteria: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  const { code } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.tier, 'powerful');
});

test('routeModel throws on verifiedAt null without allowUnverified', () => {
  assert.throws(
    () => routeModel('tiny', /** @type {any} */ (PLACEHOLDER_POLICY)),
    /\[UNVERIFIED\]/
  );
});

test('assertEvalBaselineExists blocks a verified ID with no baseline', async () => {
  const { taskStatePath, policyPath, evalsDir, root } = await makeWorkspace({ policy: VERIFIED_POLICY, withBaselines: false });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 1);
  assert.match(out, /BLOCKED/);
  assert.match(out, /No eval baseline for tiny/);
  // The block is durable: the hint records mode 'blocked' (a stale advisory
  // hint cannot survive) and a blocked model_route trace event is appended.
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.mode, 'blocked');
  // #27: the durable blocked hint still carries the advisory tier metadata.
  assert.equal(hint.tier, 'cheap');
  assert.equal(typeof hint.tierReason, 'string');
  const trace = await fsp.readFile(join(root, '.devmate', 'state', 'trace', 't-route.jsonl'), 'utf8');
  const events = /** @type {any[]} */ (parseJsonl(trace));
  assert.ok(events.some((e) => e.type === 'model_route' && e.mode === 'blocked'));
  // Direct guard check too.
  await assert.rejects(
    assertRouteAllowed({ budgetClass: 'tiny', modelId: 'real-tiny-model', verified: true }, evalsDir),
    /No eval baseline/
  );
});

test('verified route with committed baseline is honored (enforced mode)', async () => {
  const { taskStatePath, policyPath, evalsDir, root } = await makeWorkspace({ policy: VERIFIED_POLICY, withBaselines: true });
  const { code } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.mode, 'enforced');
  assert.equal(hint.modelId, 'real-tiny-model');
});

test('records a route trace event', async () => {
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ budgetClass: 'large' });
  await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  const trace = await fsp.readFile(join(root, '.devmate', 'state', 'trace', 't-route.jsonl'), 'utf8');
  const events = /** @type {any[]} */ (parseJsonl(trace));
  const routeEvent = events.find((e) => e.type === 'model_route');
  assert.ok(routeEvent, 'model_route event appended');
  assert.equal(routeEvent.budgetClass, 'large');
  assert.equal(routeEvent.mode, 'advisory');
  assert.equal(routeEvent.taskId, 't-route');
  // #27: the tier on the trace event can only be there if the decision routed
  // through the gateway seam (its record sink is the sole telemetry source).
  assert.equal(routeEvent.tier, 'powerful');
  assert.match(routeEvent.tierReason, /large budget class/);
});

test('unclassified state falls back to standard advisory without crashing', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'route-model-uncls-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const taskStatePath = join(stateDir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify({ taskId: 't-uncls', schemaVersion: 1 }), 'utf8');
  const policyPath = join(root, 'model-policy.json');
  await fsp.writeFile(policyPath, JSON.stringify(PLACEHOLDER_POLICY), 'utf8');
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir: join(root, 'evals'), traceRoot: root });
  assert.equal(code, 0);
  assert.match(out, /unclassified session/);
  const hint = JSON.parse(await fsp.readFile(join(stateDir, 'model-route.json'), 'utf8'));
  assert.equal(hint.budgetClass, 'standard');
});

// ---- FO-7: per-worker role hints in model-route.json ----

/**
 * Add a roles block to a base policy fixture.
 * @param {Record<string, unknown>} policy
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function withDiscoveryWorkerRole(policy, entry) {
  return { ...policy, roles: { discoveryWorker: entry } };
}

/**
 * Write the committed role baseline fixture for discoveryWorker.
 * @param {string} evalsDir
 * @returns {Promise<void>}
 */
async function writeRoleBaseline(evalsDir) {
  await fsp.mkdir(join(evalsDir, 'model-routing'), { recursive: true });
  await fsp.writeFile(
    join(evalsDir, 'model-routing', 'baseline-discovery-worker.json'),
    JSON.stringify({ role: 'discoveryWorker', recordedAt: new Date().toISOString(), taskSetHash: 'x', taskCount: 1, metrics: { costUsd: 0, qualityScore: 0 } }),
    'utf8'
  );
}

test('unverified role entry surfaces as an advisory role hint (exit 0)', async () => {
  const policy = withDiscoveryWorkerRole(PLACEHOLDER_POLICY, {
    modelId: '[UNVERIFIED — worker]',
    verifiedAt: null,
    rationale: 'read-only search',
  });
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ policy });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0, out);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.deepEqual(hint.roles, {
    discoveryWorker: { modelId: '[UNVERIFIED — worker]', mode: 'advisory' },
  });
});

test('policy without a roles block writes a hint without a roles field', async () => {
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace();
  const { code } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal('roles' in hint, false, 'older policies must produce a byte-identical hint');
});

test('verified role route without its role baseline is blocked (exit 1, durable blocked hint)', async () => {
  // Classes stay placeholder/advisory — the role alone must be able to fail the run.
  const policy = withDiscoveryWorkerRole(PLACEHOLDER_POLICY, {
    modelId: 'real-worker-model',
    verifiedAt: '2026-07-01',
    source: 'https://docs.example/models',
  });
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ policy });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 1);
  assert.match(out, /BLOCKED — verified role route not honored/);
  assert.match(out, /No eval baseline for role discoveryWorker/);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.roles.discoveryWorker.mode, 'blocked');
  // The class route is untouched by the role block.
  assert.equal(hint.mode, 'advisory');
});

test('verified role route with the committed role baseline is honored (enforced mode)', async () => {
  const policy = withDiscoveryWorkerRole(PLACEHOLDER_POLICY, {
    modelId: 'real-worker-model',
    verifiedAt: '2026-07-01',
    source: 'https://docs.example/models',
  });
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ policy });
  await writeRoleBaseline(evalsDir);
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 0, out);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.deepEqual(hint.roles, {
    discoveryWorker: { modelId: 'real-worker-model', mode: 'enforced' },
  });
});

test('a class-route block still records the role hints in the durable blocked hint', async () => {
  const policy = withDiscoveryWorkerRole(VERIFIED_POLICY, {
    modelId: '[UNVERIFIED — worker]',
    verifiedAt: null,
  });
  const { root, taskStatePath, policyPath, evalsDir } = await makeWorkspace({ policy, withBaselines: false });
  const { code, out } = await run([taskStatePath], { policyPath, evalsDir, traceRoot: root });
  assert.equal(code, 1);
  assert.match(out, /BLOCKED — verified route not honored/);
  const hint = JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'model-route.json'), 'utf8'));
  assert.equal(hint.mode, 'blocked');
  assert.deepEqual(hint.roles, {
    discoveryWorker: { modelId: '[UNVERIFIED — worker]', mode: 'advisory' },
  });
});
