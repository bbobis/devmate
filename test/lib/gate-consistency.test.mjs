// @ts-check
/**
 * Issue #5: gate-evidence consistency unit tests. Exercise the PURE core
 * (analyzeGateConsistency) across every divergence class, the tolerant trace
 * reader (readTraceConsistency), the async wrapper's off-chain/steering
 * behaviour, and a cross-check proving LANE_EVIDENCE_CHAIN never drifts from
 * the canonical transition table in lib/gate-transitions.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeGateConsistency,
  readTraceConsistency,
  checkGateConsistency,
  pruneArtifactHashesForRollback,
  LANE_EVIDENCE_CHAIN,
  MALFORMED_TRACE_THRESHOLD,
} from '../../lib/gate-consistency.mjs';
import { flattenTransitions } from '../../lib/gate-transitions.mjs';

/** @typedef {import('../../lib/gate-consistency.mjs').EvidenceCheckpoint} EvidenceCheckpoint */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

/**
 * Build the checkpoint list for a lane where the first `backedThrough` gates
 * are fully evidence-backed and the rest are absent. Human-audit gates are
 * marked as such; their audit is present iff they fall within the backed slice.
 * @param {import('../../lib/types.mjs').Lane} lane
 * @param {number} backedThrough  Count of leading gates that are backed.
 * @param {Set<WorkflowGate>} [humanGates]
 * @returns {EvidenceCheckpoint[]}
 */
function checkpointsFor(lane, backedThrough, humanGates = new Set(['spec-approved', 'pr-ready'])) {
  const chain = LANE_EVIDENCE_CHAIN[lane];
  return chain.map((gate, i) => {
    const backed = i < backedThrough;
    const requiresHumanAudit = humanGates.has(gate);
    return {
      gate,
      present: backed,
      requiresHumanAudit,
      humanAuditPresent: backed && requiresHumanAudit,
      label: gate,
      artifactPath: `.devmate/state/${gate}.json`,
    };
  });
}

/**
 * @param {Partial<Parameters<typeof analyzeGateConsistency>[0]>} over
 * @returns {Parameters<typeof analyzeGateConsistency>[0]}
 */
function analyzeInput(over) {
  return {
    lane: 'feature',
    gate: 'lane-set',
    checkpoints: [],
    transitions: [],
    malformedRatio: 0,
    traceFile: '.devmate/state/trace/t.jsonl',
    ...over,
  };
}

test('consistent: gate exactly at the last evidence-backed checkpoint', () => {
  const chain = LANE_EVIDENCE_CHAIN.feature;
  const result = analyzeGateConsistency(
    analyzeInput({
      gate: 'grill-done',
      checkpoints: checkpointsFor('feature', chain.indexOf('grill-done') + 1),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'consistent');
  assert.equal(result.evidenceBackedGate, 'grill-done');
  assert.deepEqual(result.divergences, []);
  assert.equal(result.recommendedCommand, null);
});

test('forward tamper: gate ahead of evidence is flagged and names the rollback target', () => {
  // Backed through plan-done (index 3); gate hand-set to spec-approved.
  const result = analyzeGateConsistency(
    analyzeInput({
      gate: 'spec-approved',
      checkpoints: checkpointsFor('feature', 4),
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'desynced');
  assert.ok(result.divergences.includes('forward'));
  assert.equal(result.evidenceBackedGate, 'plan-done');
  assert.match(result.findings.join('\n'), /gate ahead of evidence/);
  assert.match(result.findings.join('\n'), /plan-done/);
  assert.ok(result.recommendedCommand && result.recommendedCommand.includes('--fix'));
});

test('backward tamper: trace records more progress than the persisted gate', () => {
  // Everything through spec-approved is backed AND the gate is legitimately at
  // spec-approved, but the trace shows advancement to impl-started; the reset
  // to lane-set is the tamper we model by pointing gate behind the trace.
  const result = analyzeGateConsistency(
    analyzeInput({
      gate: 'lane-set',
      checkpoints: checkpointsFor('feature', 1),
      transitions: [
        { to: 'lane-set', audited: false },
        { to: 'discovery-done', audited: false },
        { to: 'grill-done', audited: false },
      ],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.divergences.includes('backward'));
  assert.match(result.findings.join('\n'), /gate behind trace/);
  assert.match(result.findings.join('\n'), /do NOT re-dispatch/);
});

test('forged approval: human gate reached without an audited transition', () => {
  // spec-approved artifact (spec.md) is present, but there is no audited
  // gate_transition into it → the human approval was never recorded.
  const cps = checkpointsFor('feature', LANE_EVIDENCE_CHAIN.feature.indexOf('spec-approved') + 1);
  const specApprovedIdx = LANE_EVIDENCE_CHAIN.feature.indexOf('spec-approved');
  cps[specApprovedIdx].humanAuditPresent = false; // artifact present, audit missing
  const result = analyzeGateConsistency(
    analyzeInput({ gate: 'spec-approved', checkpoints: cps }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.divergences.includes('forged'));
  assert.match(result.findings.join('\n'), /forged approval/);
});

test('malformed-trace: ratio above the threshold reports corruption with the file name', () => {
  const result = analyzeGateConsistency(
    analyzeInput({
      gate: 'grill-done',
      checkpoints: checkpointsFor('feature', LANE_EVIDENCE_CHAIN.feature.indexOf('grill-done') + 1),
      malformedRatio: MALFORMED_TRACE_THRESHOLD + 0.01,
      traceFile: '.devmate/state/trace/corrupt.jsonl',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.divergences.includes('malformed-trace'));
  assert.match(result.findings.join('\n'), /corrupt/);
  assert.match(result.findings.join('\n'), /corrupt\.jsonl/);
});

test('malformed-trace: ratio at/below the threshold is not flagged', () => {
  const result = analyzeGateConsistency(
    analyzeInput({
      gate: 'grill-done',
      checkpoints: checkpointsFor('feature', LANE_EVIDENCE_CHAIN.feature.indexOf('grill-done') + 1),
      malformedRatio: MALFORMED_TRACE_THRESHOLD, // boundary is inclusive-OK
    }),
  );
  assert.ok(!result.divergences.includes('malformed-trace'));
});

test('no evidence at all: rollback target is no-lane', () => {
  const result = analyzeGateConsistency(
    analyzeInput({ gate: 'discovery-done', checkpoints: checkpointsFor('feature', 0) }),
  );
  assert.equal(result.evidenceBackedGate, 'no-lane');
  assert.ok(result.divergences.includes('forward'));
});

test('readTraceConsistency: missing file yields empty, zero malformed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gc-trace-'));
  const out = await readTraceConsistency(dir, 'does-not-exist');
  assert.deepEqual(out.transitions, []);
  assert.equal(out.malformedRatio, 0);
  assert.equal(out.totalLines, 0);
});

test('readTraceConsistency: captures gate_transition audit flag and counts malformed lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gc-trace-'));
  const taskId = 't-trace';
  const good = JSON.stringify({
    type: 'gate_transition',
    taskId,
    stepId: 's1',
    ts: new Date().toISOString(),
    schemaVersion: 1,
    from: 'spec-draft',
    to: 'spec-approved',
    gate: 'spec-approved',
    actor: 'hook-exact-phrase',
    evidence: 'approve spec',
  });
  const unaudited = JSON.stringify({
    type: 'gate_transition',
    taskId,
    stepId: 's2',
    ts: new Date().toISOString(),
    schemaVersion: 1,
    from: 'lane-set',
    to: 'discovery-done',
    gate: 'discovery-done',
  });
  const lines = [good, unaudited, '{ not json', 'also not json'];
  await writeFile(join(dir, `${taskId}.jsonl`), lines.join('\n'), 'utf8');

  const out = await readTraceConsistency(dir, taskId);
  assert.equal(out.totalLines, 4);
  assert.equal(out.malformedRatio, 0.5);
  assert.equal(out.transitions.length, 2);
  const approved = out.transitions.find((t) => t.to === 'spec-approved');
  assert.equal(approved?.audited, true);
  const disc = out.transitions.find((t) => t.to === 'discovery-done');
  assert.equal(disc?.audited, false);
});

test('checkGateConsistency: off-chain terminal gate is consistent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-wrap-'));
  await mkdir(join(root, '.devmate', 'state', 'trace'), { recursive: true });
  const state = /** @type {import('../../lib/types.mjs').TaskState} */ ({
    taskId: 't-done',
    lane: 'feature',
    workflowGate: 'done',
    currentStep: 0,
  });
  const result = await checkGateConsistency(state, { root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'consistent');
});

test('checkGateConsistency: off-chain gate still reports a corrupt trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-wrap-'));
  const traceDir = join(root, '.devmate', 'state', 'trace');
  await mkdir(traceDir, { recursive: true });
  await writeFile(join(traceDir, 't-park.jsonl'), 'garbage\nmore garbage\n', 'utf8');
  const state = /** @type {import('../../lib/types.mjs').TaskState} */ ({
    taskId: 't-park',
    lane: 'feature',
    workflowGate: 'parked',
    currentStep: 0,
  });
  const result = await checkGateConsistency(state, { root });
  assert.equal(result.ok, false);
  assert.ok(result.divergences.includes('malformed-trace'));
});

test('checkGateConsistency: a foreign-task artifact does NOT back the gate (ownership)', async () => {
  // A router-result.json left over from a PRIOR task must not satisfy lane-set
  // for the active task — otherwise a hand-advanced gate rides on stale trust.
  const root = await mkdtemp(join(tmpdir(), 'gc-own-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(join(stateDir, 'trace'), { recursive: true });
  await writeFile(
    join(stateDir, 'router-result.json'),
    JSON.stringify({ taskId: 'OTHER-TASK', lane: 'feature', budgetClass: 'standard', confidence: 0.95 }),
    'utf8',
  );
  const state = /** @type {import('../../lib/types.mjs').TaskState} */ ({
    taskId: 'ACTIVE-TASK',
    lane: 'feature',
    workflowGate: 'lane-set',
    currentStep: 0,
  });
  const result = await checkGateConsistency(state, { root });
  // lane-set is NOT backed (the router result belongs to OTHER-TASK), so the
  // gate is ahead of its evidence and the rollback target is no-lane.
  assert.equal(result.ok, false);
  assert.ok(result.divergences.includes('forward'));
  assert.equal(result.evidenceBackedGate, 'no-lane');
});

test('checkGateConsistency: the active task\'s own router artifact DOES back the gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-own-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(join(stateDir, 'trace'), { recursive: true });
  await writeFile(
    join(stateDir, 'router-result.json'),
    JSON.stringify({ taskId: 'ACTIVE-TASK', lane: 'feature', budgetClass: 'standard', confidence: 0.95 }),
    'utf8',
  );
  const state = /** @type {import('../../lib/types.mjs').TaskState} */ ({
    taskId: 'ACTIVE-TASK',
    lane: 'feature',
    workflowGate: 'lane-set',
    currentStep: 0,
  });
  const result = await checkGateConsistency(state, { root });
  assert.equal(result.ok, true);
});

test('pruneArtifactHashesForRollback: drops hashes for gates beyond the rollback target', () => {
  const hashes = {
    design: '.devmate/state/plan.json',
    designDigest: 'aaa',
    plan: '.devmate/state/plan.json',
    planDigest: 'bbb',
    critique: '.devmate/state/critique-result.json',
    critiqueDigest: 'ccc',
    spec: '.devmate/session/spec.md',
    specDigest: 'ddd',
  };
  // Roll back to no-lane: nothing on the chain survives.
  assert.deepEqual(pruneArtifactHashesForRollback(hashes, 'no-lane'), {});

  // Roll back to plan-done: design/plan/critique (era plan-done) survive; spec
  // (era spec-draft, which is LATER) is stale residue and is dropped.
  const atPlanDone = pruneArtifactHashesForRollback(hashes, 'plan-done');
  assert.deepEqual(atPlanDone, {
    design: '.devmate/state/plan.json',
    designDigest: 'aaa',
    plan: '.devmate/state/plan.json',
    planDigest: 'bbb',
    critique: '.devmate/state/critique-result.json',
    critiqueDigest: 'ccc',
  });

  // Roll back to spec-draft: everything survives.
  assert.deepEqual(pruneArtifactHashesForRollback(hashes, 'spec-draft'), hashes);
});

test('pruneArtifactHashesForRollback: leaves unknown (non-devmate) keys untouched', () => {
  const hashes = { custom: 'x', customDigest: 'y', spec: 's', specDigest: 'sd' };
  // Rolling back to no-lane drops spec/specDigest but keeps the foreign keys.
  assert.deepEqual(pruneArtifactHashesForRollback(hashes, 'no-lane'), {
    custom: 'x',
    customDigest: 'y',
  });
});

test('cross-check: every LANE_EVIDENCE_CHAIN edge exists in flattenTransitions', () => {
  const flat = flattenTransitions();
  for (const [lane, chain] of Object.entries(LANE_EVIDENCE_CHAIN)) {
    for (const gate of chain) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(flat, gate),
        `[${lane}] gate "${gate}" is not a known gate in flattenTransitions()`,
      );
    }
    for (let i = 0; i < chain.length - 1; i += 1) {
      const from = chain[i];
      const to = chain[i + 1];
      assert.ok(
        (flat[from] ?? []).includes(to),
        `[${lane}] edge "${from}" -> "${to}" is not a legal transition`,
      );
    }
  }
});
