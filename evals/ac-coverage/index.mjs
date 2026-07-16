// @ts-check
/**
 * AC-6 (epic #416): the AC-coverage eval entrypoint. Loads the fixture
 * scenarios, materializes each into a real `.devmate/` root, runs the REAL
 * harm-reduction path end to end — AC-1's `computeAcCoverage` read plus AC-2's
 * `pr-ready` gate (`checkGatePrecondition`) under every `acCoverageGate` mode
 * (off / warn / block) — and scores observed-vs-expected with the pure scorer
 * (./scorer.mjs). Returns a typed CoverageReport.
 *
 * This module owns all the filesystem I/O (temp-root materialization); the
 * `scripts/run-ac-coverage-evals.mjs` CLI is a thin wrapper that only writes the
 * report artifact. No LLM calls — fully deterministic from fixtures (the only
 * clock use is the `generatedAt` stamp the CLI adds to the written artifact).
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAcceptanceCriteria,
  completedAcNumbers,
  computeAcCoverage,
  acStepId,
} from '../../lib/spec-progress.mjs';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import { readTrace } from '../../lib/trace/read-trace.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';
import { scoreScenario, buildCoverageReport } from './scorer.mjs';

/** @typedef {import('./scorer.mjs').GateDecision} GateDecision */
/** @typedef {import('./scorer.mjs').CoverageVerdict} CoverageVerdict */
/** @typedef {import('./scorer.mjs').ScenarioResult} ScenarioResult */
/** @typedef {import('./scorer.mjs').CoverageReport} CoverageReport */

/**
 * One acceptance criterion in a fixture spec.
 * @typedef {Object} AcFixtureAc
 * @property {number} id
 * @property {string} text
 */

/**
 * A single eval scenario, declared in fixtures/scenarios.json.
 * @typedef {Object} AcScenario
 * @property {string} id                 Stable kebab id (also used as the taskId).
 * @property {string} lane               Workflow lane driving the fail-closed rule.
 * @property {'correct'|'miss'|'known-limitation'} category
 * @property {string} [note]
 * @property {AcFixtureAc[]} specAcs     Rendered into the `## Acceptance criteria` section (empty → no section).
 * @property {number[]} completedAcIds   Seeded as `impl-AC{n}` step_complete trace events.
 * @property {CoverageVerdict} expected  The correct verdict, from first principles.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The scenario fixtures. */
export const FIXTURES_PATH = resolve(__dirname, 'fixtures', 'scenarios.json');

/** A fixed, deterministic timestamp stamped on every seeded completion event. */
const FIXED_TS = '2026-01-01T00:00:00.000Z';

/**
 * Load the scenario fixtures from disk.
 * @returns {AcScenario[]}
 */
export function loadScenarios() {
  const data = /** @type {{ scenarios: AcScenario[] }} */ (JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')));
  return data.scenarios;
}

/**
 * Render a fixture spec's markdown. An empty `specAcs` yields a spec with no
 * `## Acceptance criteria` section, so `parseAcceptanceCriteria` returns [].
 * @param {AcFixtureAc[]} specAcs
 * @returns {string}
 */
function renderSpec(specAcs) {
  if (specAcs.length === 0) {
    return ['# spec', '', 'No acceptance criteria section here.', ''].join('\n');
  }
  return [
    '# spec',
    '',
    '## Acceptance criteria',
    '',
    ...specAcs.map((a) => `- [ ] AC${a.id}: ${a.text}`),
    '',
  ].join('\n');
}

/**
 * Build a schema-valid `impl-AC{n}` step_complete trace event.
 * @param {number} n
 * @param {string} taskId
 * @returns {Record<string, unknown>}
 */
function completeEvent(n, taskId) {
  return {
    type: 'step_complete',
    stepId: acStepId(n),
    taskId,
    ts: FIXED_TS,
    schemaVersion: 1,
    label: `AC${n} complete`,
    artifactPaths: [],
  };
}

/**
 * Materialize a scenario into a real `.devmate/` layout under `root` for one
 * gate mode. Mirrors the fixture shape in
 * test/lib/gate-preconditions.ac-coverage.test.mjs.
 * @param {string} root
 * @param {AcScenario} scenario
 * @param {'off'|'warn'|'block'} mode
 * @returns {{ stateDir: string, taskId: string, specPath: string, traceFile: string }}
 */
function materializeScenario(root, scenario, mode) {
  const devmate = join(root, '.devmate');
  const stateDir = join(devmate, 'state');
  const sessionDir = join(devmate, 'session');
  const traceDir = join(stateDir, 'trace');
  mkdirSync(traceDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const config = {
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['**'] }],
    acCoverageGate: mode,
  };
  writeFileSync(join(devmate, 'devmate.config.json'), JSON.stringify(config), 'utf8');

  const specPath = join(sessionDir, 'spec.md');
  writeFileSync(specPath, renderSpec(scenario.specAcs), 'utf8');

  const taskId = scenario.id;
  writeFileSync(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId,
      lane: scenario.lane,
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );

  const traceFile = join(traceDir, `${taskId}.jsonl`);
  if (scenario.completedAcIds.length > 0) {
    const lines = scenario.completedAcIds.map((n) => JSON.stringify(completeEvent(n, taskId)));
    writeFileSync(traceFile, lines.join('\n') + '\n', 'utf8');
  }

  return { stateDir, taskId, specPath, traceFile };
}

/**
 * Read raw AC-1 coverage (the disk-truth read the gate depends on) for a
 * materialized scenario, exercising the real `parseAcceptanceCriteria` +
 * `completedAcNumbers` + `computeAcCoverage` pipeline.
 * @param {string} specPath
 * @param {string} taskId
 * @param {string} stateDir
 * @returns {Promise<{ total: number, completed: number, ok: boolean }>}
 */
async function readCoverage(specPath, taskId, stateDir) {
  const criteria = parseAcceptanceCriteria(readFileSync(specPath, 'utf8'));
  const { steps } = await readTrace(taskId, { traceDir: join(stateDir, 'trace') });
  const coverage = computeAcCoverage(criteria, completedAcNumbers(steps));
  return { total: coverage.total, completed: coverage.completed, ok: coverage.ok };
}

/**
 * Count the ac-coverage contract_violation events warn mode wrote to a trace.
 * @param {string} traceFile
 * @returns {number}
 */
function countAcViolations(traceFile) {
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(traceFile, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const ev of parseJsonl(raw)) {
    if (ev && typeof ev === 'object') {
      const rec = /** @type {Record<string, unknown>} */ (ev);
      if (rec.type === 'contract_violation' && rec.contract === 'ac-coverage') count += 1;
    }
  }
  return count;
}

/**
 * Run one gate mode of a scenario in a fresh temp root and observe the result.
 * @param {AcScenario} scenario
 * @param {'off'|'warn'|'block'} mode
 * @param {string} tmpBase
 * @returns {Promise<{ decision: GateDecision, warnViolations: number, coverage: { total: number, completed: number, ok: boolean } }>}
 */
async function runMode(scenario, mode, tmpBase) {
  const root = mkdtempSync(join(tmpBase, `ac-${scenario.id}-${mode}-`));
  try {
    const { stateDir, taskId, specPath, traceFile } = materializeScenario(root, scenario, mode);
    const coverage = await readCoverage(specPath, taskId, stateDir);
    const verdict = await checkGatePrecondition('pr-ready', {
      stateDir,
      lane: scenario.lane,
      taskId,
    });
    return {
      decision: verdict.ok ? 'allow' : 'refuse',
      warnViolations: mode === 'warn' ? countAcViolations(traceFile) : 0,
      coverage,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run one scenario through the real AC-1 read + AC-2 `pr-ready` gate under every
 * mode (each in its own fresh temp root) and collect the observed verdict.
 * @param {AcScenario} scenario
 * @param {string} tmpBase  Base dir for the per-mode temp roots.
 * @returns {Promise<CoverageVerdict>}
 */
export async function runScenario(scenario, tmpBase) {
  const off = await runMode(scenario, 'off', tmpBase);
  const warn = await runMode(scenario, 'warn', tmpBase);
  const block = await runMode(scenario, 'block', tmpBase);
  const cov = off.coverage; // coverage is mode-independent — any mode's read is identical
  return {
    total: cov.total,
    completed: cov.completed,
    coverageOk: cov.ok,
    off: off.decision,
    warn: warn.decision,
    block: block.decision,
    warnViolations: warn.warnViolations,
  };
}

/**
 * Evaluate every scenario and aggregate the coverage report. Deterministic: no
 * clock, no repo writes — the CLI stamps the timestamp and writes the artifact.
 * Safe for the eval-of-the-eval to assert on directly.
 * @param {AcScenario[]} scenarios
 * @param {{ tmpBase?: string }} [opts]
 * @returns {Promise<CoverageReport>}
 */
export async function evaluateScenarios(scenarios, opts = {}) {
  const tmpBase = opts.tmpBase ?? tmpdir();
  /** @type {ScenarioResult[]} */
  const results = [];
  for (const scenario of scenarios) {
    const observed = await runScenario(scenario, tmpBase);
    const score = scoreScenario(scenario.id, scenario.expected, observed);
    results.push({
      id: scenario.id,
      lane: scenario.lane,
      category: scenario.category,
      observed,
      score,
      note: scenario.note ?? null,
    });
  }
  return buildCoverageReport(results);
}
