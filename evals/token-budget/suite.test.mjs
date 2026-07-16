// @ts-check
/**
 * E9-21: token-budget eval — drives a deterministic synthetic long trajectory
 * through the REAL budget/fact-writer/compaction/memory libraries and asserts
 * the four bounding invariants:
 *   1. budget_warning fires when the class threshold is crossed (E9-07);
 *   2. the compaction artifact is resume-sufficient (E4-7);
 *   3. the post-compaction active context stays within the class threshold
 *      (E9-09 estimator);
 *   4. the active task ledger is promoted to the repo ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as checkBudgetMain } from '../../scripts/check-session-budget.mjs';
import { main as compactMain } from '../../scripts/compact-session.mjs';
import { writeFact } from '../../lib/memory/fact-writer.mjs';
import { taskLedgerPath, repoLedgerPath } from '../../lib/memory/paths.mjs';
import { loadCompactionArtifact, canResumeFromCompaction } from '../../lib/context/compaction.mjs';
import { estimateTokens } from '../../lib/context/estimate-tokens.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';
import { scoreTokenBudget } from './scorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  await fsp.readFile(join(__dirname, 'fixtures', 'trajectory.json'), 'utf8')
);

/** Silence stdio while driving the CLIs. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
function silence() {
  process.stdout.write = /** @type {typeof process.stdout.write} */ (() => true);
  process.stderr.write = /** @type {typeof process.stderr.write} */ (() => true);
}
function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/**
 * Run the whole synthetic trajectory in a canonical-layout temp root and
 * return the observations the pure scorer needs.
 * @returns {Promise<import('./scorer.mjs').TokenBudgetObservations & { artifact: any }>}
 */
async function runTrajectory() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'token-budget-eval-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const taskId = FIXTURES.taskId;

  // 1. Seed a task with a tiny-class contract (E9-06 shape) + evidence pack.
  const sessionPath = join(root, 'session.md');
  await fsp.writeFile(sessionPath, 'x'.repeat(FIXTURES.sessionFillBytes), 'utf8');
  const statePath = join(stateDir, 'task.json');
  await fsp.writeFile(
    statePath,
    JSON.stringify({
      taskId,
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
      sessionPath,
      loadedSkills: [],
      outputContract: {
        lane: 'feature',
        format: 'pr',
        audience: 'orchestrator',
        done_when: FIXTURES.goal,
        evidence_required: FIXTURES.evidenceRequired,
        citation_mode: 'inline',
        token_budget_class: FIXTURES.budgetClass,
        max_context_sources: 3,
        created_at: FIXTURES.baseTs,
      },
      evidencePack: {
        taskId,
        stage: 'impl-started',
        pointers: FIXTURES.evidencePointers,
        maxSources: 3,
        created_at: FIXTURES.baseTs,
      },
    }),
    'utf8'
  );

  // Trace events the compaction reads for nextAction derivation live at the
  // canonical single-file location relative to the repo root.
  await fsp.writeFile(
    join(stateDir, 'trace.jsonl'),
    FIXTURES.traceEvents.map((/** @type {unknown} */ e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );

  // 2. Long trajectory: write every fixture fact through the real fact-writer.
  const ledgerPath = taskLedgerPath(root, taskId);
  for (const fact of FIXTURES.facts) {
    const result = await writeFact(
      { tool_name: fact.tool_name, path: fact.path, cwd: root },
      ledgerPath,
      { workspaceRoot: root }
    );
    assert.equal(result.ok, true, `fact write ok for ${fact.path}`);
  }

  // 3. Budget check crosses the tiny warn threshold → budget_warning fires.
  silence();
  let budgetExit;
  try {
    budgetExit = await checkBudgetMain([statePath], { traceRoot: root });
  } finally {
    restore();
  }
  assert.ok(budgetExit === 1 || budgetExit === 2, 'session is over the tiny threshold');

  // 4. Compaction from the canonical layout (promotes the ledger + renders
  //    memory). compact-session resolves the trace file relative to cwd, so
  //    run it from the temp root.
  const outputDir = join(stateDir, 'compaction');
  const prevCwd = process.cwd();
  silence();
  try {
    process.chdir(root);
    const compactExit = await compactMain([statePath, outputDir]);
    assert.equal(compactExit, 0, 'compaction succeeds');
  } finally {
    process.chdir(prevCwd);
    restore();
  }

  // Gather observations.
  const traceRaw = await fsp.readFile(join(stateDir, 'trace', `${taskId}.jsonl`), 'utf8');
  const traceEvents = /** @type {any[]} */ (parseJsonl(traceRaw));
  const artifact = await loadCompactionArtifact(outputDir);
  assert.notEqual(artifact, null, 'compaction artifact written');
  const resumeVerdict = canResumeFromCompaction(/** @type {any} */ (artifact));
  // The compaction artifact IS the post-compaction active context seed.
  const estimatedTokens = estimateTokens(JSON.stringify(artifact));
  /** @type {Array<Record<string, unknown>>} */
  let repoEntries = [];
  try {
    const repoRaw = await fsp.readFile(repoLedgerPath(root), 'utf8');
    repoEntries = /** @type {Array<Record<string, unknown>>} */ (parseJsonl(repoRaw));
  } catch {
    repoEntries = [];
  }

  return {
    traceEvents,
    resumeVerdict,
    estimatedTokens,
    classThresholdTokens: FIXTURES.classWarnThresholdTokens,
    promotedFactCount: repoEntries.length,
    artifact,
  };
}

const OBS = await runTrajectory();
const RESULT = scoreTokenBudget(OBS);

test('budget_warning fires on threshold crossing', () => {
  assert.equal(RESULT.budgetEventsFired, true, JSON.stringify(OBS.traceEvents));
});

test('resume sufficient after compaction', () => {
  assert.equal(RESULT.resumeSufficient, true, JSON.stringify(OBS.resumeVerdict));
});

test('active context bounded post-compaction', () => {
  assert.equal(
    RESULT.activeContextBounded,
    true,
    `estimated ${OBS.estimatedTokens} tokens vs threshold ${OBS.classThresholdTokens}`
  );
});

test('ledger promoted', () => {
  assert.equal(RESULT.ledgerPromoted, true);
  // Same-path fixture facts supersede one another in the ledger (and
  // same-millisecond writes may stale collaterally), so assert presence
  // rather than an exact count.
  assert.ok(OBS.promotedFactCount >= 1, 'promoted facts present');
});

test('all four invariants hold (score 4/4)', () => {
  assert.equal(RESULT.score, 4, JSON.stringify(RESULT));
});
