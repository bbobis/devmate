// @ts-check
// CI-parity driver for the /implement-issue skill.
//
// `npm run verify` is necessary but NOT sufficient: the CI `verify` job runs a
// superset of guards, and a second `hooks-smoke` job runs four hook test files
// on three OSes. This driver runs every step of both jobs locally, in CI order,
// so a green run here means a green PR (modulo Windows/macOS-only failures).
//
// It reuses the repo's own primitives: the safe no-shell spawn from
// lib/loop/run-command.mjs and the TCM-9 output cap from lib/loop/output-cap.mjs
// — each step prints a one-line digest and a pointer to its full log in a temp
// dir; full logs never hit the terminal.
//
// Usage (from the repo root, Node 24+):
//   node .claude/skills/implement-issue/ci-parity.mjs              # all steps
//   node .claude/skills/implement-issue/ci-parity.mjs lint test    # subset by id
//   node .claude/skills/implement-issue/ci-parity.mjs --list       # list step ids
//
// Exit code: 0 when every executed step passes, 1 otherwise.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../../../lib/env-guard.mjs';
import { runCommand } from '../../../lib/loop/run-command.mjs';
import { redactSecrets } from '../../../lib/loop/output-cap.mjs';
import { writeTextFileSync } from '../../../lib/fs-safe.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE = process.execPath;

/** Per-step timeout. The full test suite takes ~20s on CI-class hardware. */
const STEP_TIMEOUT_MS = 600_000;

/** Max characters of a failing step's log tail shown in the terminal (TCM-9). */
const FAIL_TAIL_BYTES = 2_000;

/**
 * @typedef {Object} Step
 * @property {string} id       Short id used for subset selection.
 * @property {string[]} argv   Command as an argv array (never a shell string).
 * @property {string} [note]   Caveat printed with the step result.
 * @property {boolean} [skipOnWindows]  Step cannot run without a shell on win32.
 */

/**
 * Steps mirror .github/workflows/ci.yml: the `verify` job's commands in order
 * (npm run verify expanded into its sub-commands so failures are granular),
 * then the CI-only guards, then the hooks-smoke job's test files.
 * @type {Step[]}
 */
const STEPS = [
  { id: 'lint', argv: [NODE, 'node_modules/eslint/bin/eslint.js', '.', '--max-warnings', '0'] },
  { id: 'typecheck', argv: [NODE, 'node_modules/typescript/bin/tsc', '-p', 'jsconfig.json'] },
  { id: 'test', argv: [NODE, '--test'] },
  { id: 'check-contracts', argv: [NODE, 'scripts/check-contracts.mjs'] },
  { id: 'check-docs-drift', argv: [NODE, 'scripts/check-docs-drift.mjs'] },
  { id: 'check-script-refs', argv: [NODE, 'scripts/check-script-refs.mjs'] },
  { id: 'check-entrypoint-guard', argv: [NODE, 'scripts/check-entrypoint-guard.mjs'] },
  {
    id: 'check-contract-drift',
    argv: [NODE, 'scripts/check-contract-drift.mjs'],
    note: 'cross-repo half self-skips without a ../monoroot checkout; the in-repo hashes always run',
  },
  {
    id: 'audit',
    argv: ['npm', 'audit', '--audit-level=high'],
    skipOnWindows: true,
    note: 'on Windows run `npm audit --audit-level=high` manually',
  },
  { id: 'memory-path-refs', argv: [NODE, 'scripts/check-memory-path-refs.mjs'] },
  {
    id: 'gen-current-behavior',
    argv: [NODE, 'scripts/generate-current-behavior.mjs'],
    note: 'regenerates docs/CURRENT_BEHAVIOR.md in the working tree',
  },
  {
    id: 'current-behavior-diff',
    argv: ['git', 'diff', '--exit-code', '--', 'docs/CURRENT_BEHAVIOR.md'],
    note: 'fails when the committed file drifts from the regenerated one — commit the diff',
  },
  { id: 'validate-agents', argv: [NODE, 'scripts/validate-agents.mjs'] },
  { id: 'worker-contract-check', argv: [NODE, 'scripts/worker-contract-check.mjs'] },
  { id: 'artifact-allowlist', argv: [NODE, 'scripts/check-artifact-allowlist.mjs'] },
  { id: 'backend-ready', argv: [NODE, 'scripts/check-backend-ready.mjs'] },
  { id: 'file-budgets', argv: [NODE, 'scripts/check-file-budgets.mjs'] },
  { id: 'generated-docs', argv: [NODE, 'scripts/check-generated-docs.mjs'] },
  { id: 'settings-keys', argv: [NODE, 'scripts/check-settings-keys.mjs'] },
  { id: 'model-policy', argv: [NODE, 'scripts/validate-model-policy.mjs'] },
  { id: 'skill-split', argv: [NODE, 'scripts/validate-skill-split.mjs'] },
  { id: 'model-routing', argv: [NODE, 'scripts/eval-model-routing.mjs'] },
  { id: 'issue-quality', argv: [NODE, 'scripts/run-issue-quality-evals.mjs'] },
  { id: 'regressions', argv: [NODE, 'scripts/run-regressions.mjs'] },
  {
    id: 'hooks-smoke',
    argv: [
      NODE,
      '--test',
      'test/lib/hooks/registry.test.mjs',
      'test/scripts/validate-hooks.test.mjs',
      'test/regression/hook-registration.test.mjs',
      'test/hooks/hook-spawn.smoke.test.mjs',
    ],
    note: 'CI also runs these on Windows + macOS; path bugs may pass here and fail there',
  },
];

/**
 * Cap text to its last `maxBytes` characters with a truncation notice.
 * Tail (not head) because failure causes cluster at the end of a log.
 * @param {string} raw
 * @param {number} maxBytes
 * @returns {string}
 */
function tailCap(raw, maxBytes) {
  if (raw.length <= maxBytes) return raw;
  return '[...log head truncated — see the step log file for the full output]\n' + raw.slice(-maxBytes);
}

/**
 * @typedef {Object} StepResult
 * @property {string} id
 * @property {'pass' | 'fail' | 'skip'} status
 * @property {number} exitCode
 * @property {number} durationMs
 * @property {string} logPath  Path to the full (redacted) log; empty when skipped.
 */

/**
 * Run one step, write its full redacted log to `runDir`, print a digest line.
 * @param {Step} step
 * @param {string} runDir
 * @returns {Promise<StepResult>}
 */
async function runStep(step, runDir) {
  if (step.skipOnWindows && process.platform === 'win32') {
    process.stdout.write(`[ci-parity] SKIP ${step.id} — ${step.note ?? 'not supported on win32'}\n`);
    return { id: step.id, status: 'skip', exitCode: 0, durationMs: 0, logPath: '' };
  }
  const result = await runCommand(step.argv, { cwd: REPO_ROOT, timeoutMs: STEP_TIMEOUT_MS });
  const combined = redactSecrets(result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''));
  const logPath = join(runDir, `${step.id}.log`);
  writeTextFileSync(logPath, combined);
  const passed = result.exitCode === 0 && !result.timedOut;
  const secs = (result.durationMs / 1000).toFixed(1);
  const status = passed ? 'PASS' : result.timedOut ? 'FAIL (timeout)' : `FAIL (exit ${result.exitCode})`;
  process.stdout.write(`[ci-parity] ${status} ${step.id} (${secs}s) log=${logPath}\n`);
  if (step.note) process.stdout.write(`[ci-parity]   note: ${step.note}\n`);
  if (!passed) process.stdout.write(tailCap(combined, FAIL_TAIL_BYTES) + '\n');
  return {
    id: step.id,
    status: passed ? 'pass' : 'fail',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    logPath,
  };
}

/**
 * Run the CI-parity steps.
 * @param {string[]} args  CLI args (without node/script): `--list`, or step ids to run.
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  if (args.includes('--list')) {
    for (const s of STEPS) process.stdout.write(`${s.id}\n`);
    return 0;
  }
  const wanted = args.filter((a) => !a.startsWith('--'));
  const unknown = wanted.filter((w) => !STEPS.some((s) => s.id === w));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown step id(s): ${unknown.join(', ')}. Use --list to see valid ids.\n`);
    return 1;
  }
  const steps = wanted.length > 0 ? STEPS.filter((s) => wanted.includes(s.id)) : STEPS;

  const runDir = mkdtempSync(join(tmpdir(), 'ci-parity-'));
  process.stdout.write(`[ci-parity] repo=${REPO_ROOT} node=${process.versions.node} logs=${runDir}\n`);

  /** @type {StepResult[]} */
  const results = [];
  for (const step of steps) {
    results.push(await runStep(step, runDir));
  }

  writeTextFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const failed = results.filter((r) => r.status === 'fail');
  const summary =
    failed.length === 0
      ? `[ci-parity] GREEN — ${results.length} step(s) passed.`
      : `[ci-parity] RED — ${failed.length} of ${results.length} step(s) failed: ${failed.map((f) => f.id).join(', ')}.`;
  process.stdout.write(`${summary} Results: ${join(runDir, 'results.json')}\n`);
  return failed.length === 0 ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
