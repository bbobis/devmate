// @ts-check

/**
 * AC-3 (epic #416): `payload.completedAcIds` is required — possibly `[]` —
 * whenever a fullstack dispatch targeted acceptance criteria.
 *
 * The "ACs were targeted" signal is the envelope-level `targetAcIds` the
 * orchestrator stamps onto the persisted result from its own dispatch context
 * (the AC-5 assignment); it is never agent-authored. A result that silently
 * drops `completedAcIds` while targets are present fails
 * `assertDispatchResult` with a precise contract error, which
 * `scripts/orch-assert-dispatch.mjs` surfaces unchanged. Prose tests pin the
 * feature-lane step-11 tail (coverage assert before `pass-verification`,
 * bounded re-dispatch, park + escalate) in both the orchestrator agent card
 * and the feature-lane skill procedure, so the two cannot silently drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDispatchResult,
  assertDispatchResultBacked,
} from '../../../lib/workflow/orchestrator.mjs';
import { main as orchAssertDispatchMain } from '../../../scripts/orch-assert-dispatch.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The verbatim contract error the issue specifies. */
const CONTRACT_ERROR = 'fullstack result must report completedAcIds (possibly []) when ACs were targeted';

/**
 * A fullstack `ok` result envelope with an overridable shape.
 * @param {Record<string, unknown>} [overrides]  Top-level envelope overrides.
 * @returns {Record<string, unknown>}
 */
function fullstackResult(overrides = {}) {
  return {
    agentName: 'fullstack',
    status: 'ok',
    payload: { verification: 'unit tests green', changedFiles: ['lib/a.mjs'], summary: 'done' },
    ...overrides,
  };
}

/**
 * A fullstack result whose payload carries `completedAcIds`.
 * @param {unknown} completedAcIds
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function withCompleted(completedAcIds, overrides = {}) {
  const base = fullstackResult(overrides);
  return {
    ...base,
    payload: { .../** @type {Record<string, unknown>} */ (base.payload), completedAcIds },
  };
}

describe('assertDispatchResult — completedAcIds required when ACs were targeted (AC-3)', () => {
  it('rejects a targeted result missing the completedAcIds key', () => {
    const r = assertDispatchResult('fullstack', fullstackResult({ targetAcIds: [3, 4] }));
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes(CONTRACT_ERROR), String(r.error));
  });

  it('accepts a targeted result with completedAcIds: [] (explicit zero-completed report)', () => {
    const r = assertDispatchResult('fullstack', withCompleted([], { targetAcIds: [3, 4] }));
    assert.deepEqual(r, { ok: true });
  });

  it('accepts a targeted result reporting the completed subset', () => {
    const r = assertDispatchResult('fullstack', withCompleted([3], { targetAcIds: [3, 4] }));
    assert.deepEqual(r, { ok: true });
  });

  it('rejects a targeted result whose completedAcIds is not an array', () => {
    for (const bad of ['3,4', 3, { 0: 3 }, true]) {
      const r = assertDispatchResult('fullstack', withCompleted(bad, { targetAcIds: [3, 4] }));
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.ok(String(r.error).includes(CONTRACT_ERROR), String(r.error));
    }
  });

  it('rejects a targeted result whose completedAcIds holds non-number entries', () => {
    const r = assertDispatchResult('fullstack', withCompleted([3, '4'], { targetAcIds: [3, 4] }));
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes(CONTRACT_ERROR), String(r.error));
  });

  it('accepts an untargeted result with no completedAcIds (unchanged for non-AC work)', () => {
    const r = assertDispatchResult('fullstack', fullstackResult());
    assert.deepEqual(r, { ok: true });
  });

  it('treats an empty targetAcIds as no targets (no requirement added)', () => {
    const r = assertDispatchResult('fullstack', fullstackResult({ targetAcIds: [] }));
    assert.deepEqual(r, { ok: true });
  });

  it('fails closed on a malformed targetAcIds instead of reading it as "no targets"', () => {
    for (const bad of [null, '3,4', 3, [3, 'x'], { 0: 3 }]) {
      const r = assertDispatchResult('fullstack', fullstackResult({ targetAcIds: bad }));
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(String(r.error), /targetAcIds must be a number\[\]/);
    }
  });

  it('enforces the requirement for persona dispatches (backend/frontend/editor resolve to fullstack)', () => {
    for (const persona of ['backend', 'frontend', 'editor']) {
      const r = assertDispatchResult(persona, fullstackResult({ targetAcIds: [1] }));
      assert.equal(r.ok, false, persona);
      assert.ok(String(r.error).includes(CONTRACT_ERROR), String(r.error));
    }
  });

  it('is not bypassed by an artifactPath shortcut', () => {
    const r = assertDispatchResult(
      'fullstack',
      fullstackResult({ targetAcIds: [1], artifactPath: '.devmate/state/worker-returns/w1.json' }),
    );
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes(CONTRACT_ERROR), String(r.error));
  });

  it('leaves non-ok results to the reason/error contract (a blocked dispatch completes nothing)', () => {
    const r = assertDispatchResult('fullstack', {
      agentName: 'fullstack',
      status: 'blocked',
      reason: 'scope conflict',
      targetAcIds: [1, 2],
    });
    assert.deepEqual(r, { ok: true });
  });

  it('flows through assertDispatchResultBacked (shape check runs before the trace check)', () => {
    const trace = [{ type: 'subagent_start', agentName: 'fullstack' }];
    const missing = assertDispatchResultBacked('fullstack', fullstackResult({ targetAcIds: [2] }), trace);
    assert.equal(missing.ok, false);
    assert.ok(String(missing.error).includes(CONTRACT_ERROR), String(missing.error));

    const explicit = assertDispatchResultBacked('fullstack', withCompleted([], { targetAcIds: [2] }), trace);
    assert.deepEqual(explicit, { ok: true });
  });
});

describe('orch-assert-dispatch.mjs surfaces the AC-3 contract error unchanged', () => {
  /**
   * Run the CLI main against a result envelope written to a temp dir,
   * capturing its single-line JSON stdout.
   * @param {Record<string, unknown>} envelope
   * @returns {Promise<{ code: number, out: string }>}
   */
  async function runCli(envelope) {
    const dir = await mkdtemp(join(tmpdir(), 'ac3-cli-'));
    const resultPath = join(dir, 'result.json');
    const tracePath = join(dir, 'trace.jsonl');
    await writeFile(resultPath, JSON.stringify(envelope), 'utf8');
    await writeFile(tracePath, JSON.stringify({ type: 'subagent_start', agentName: 'fullstack' }) + '\n', 'utf8');

    /** @type {string[]} */
    const chunks = [];
    const realOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = /** @type {typeof process.stdout.write} */ ((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      const code = orchAssertDispatchMain(['--agent', 'fullstack', '--file', resultPath, '--trace', tracePath]);
      return { code, out: chunks.join('') };
    } finally {
      process.stdout.write = realOut;
    }
  }

  it('exits 1 and prints the contract error for a targeted result missing completedAcIds', async () => {
    const { code, out } = await runCli(fullstackResult({ targetAcIds: [1, 2] }));
    assert.equal(code, 1);
    assert.ok(out.includes(CONTRACT_ERROR), out);
  });

  it('exits 0 for a targeted result reporting completedAcIds: []', async () => {
    const { code, out } = await runCli(withCompleted([], { targetAcIds: [1, 2] }));
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
  });
});

describe('step-11 prose stays aligned across the agent card and the skill procedure', () => {
  /**
   * Read a repo file and collapse whitespace so line wrapping differences
   * cannot mask (or fake) a prose match.
   * @param {string} relPath
   * @returns {Promise<string>}
   */
  async function normalized(relPath) {
    const raw = await readFile(join(REPO_ROOT, relPath), 'utf8');
    return raw.replace(/\s+/g, ' ');
  }

  /**
   * Shared step-11 sentences that must appear verbatim in BOTH files.
   *
   * These used to pin `node "${PLUGIN_ROOT}/scripts/complete-ac.mjs"` and
   * `assert-ac-coverage.mjs` — commands the orchestrator has never had a tool to
   * run (it declares no `execute`). The test enforced their PRESENCE, which is
   * how a docs-sync invariant ended up guarding an instruction that could not
   * execute. Per-AC progress now comes from the worker returns the PostToolUse
   * hook persists, which the orchestrator can actually Read.
   */
  const SHARED_STEP_11_PROSE = [
    // Where per-AC progress actually comes from: the persisted worker return.
    'Each `@fullstack` return is persisted for you by the PostToolUse hook under `.devmate/state/worker-returns/`; its `payload.completedAcIds` records which ACs that dispatch finished.',
    // Coverage checked before pass-verification fires — by reading, not running.
    "After the implementation dispatches return and before firing `pass-verification`, Read those returns and compare `completedAcIds` against the task's `acceptanceCriteria`.",
    // Bounded repair: only the missing ACs, while re-dispatch is still legal.
    'Re-dispatch `@fullstack` for only the missing ACs — the gate is still `impl-started`, where re-dispatch is legal — at most 2 re-dispatches per AC (TODO: calibrate after Phase 1 — provisional).',
    // Exhaustion: park + escalate.
    'If an AC is still missing after that bound, park the task and escalate to the human.',
    // Prose is guidance; the AC-2 precondition is the guarantee.
    'This prose is guidance; the AC-coverage gate precondition is the guarantee.',
  ];

  for (const relPath of ['agents/orchestrator.agent.md', 'skills/orchestrator-feature-lane/refs/procedure.md']) {
    it(`${relPath} carries the coverage-before-pass-verification step-11 tail`, async () => {
      const text = await normalized(relPath);
      for (const sentence of SHARED_STEP_11_PROSE) {
        assert.ok(text.includes(sentence), `${relPath} is missing: ${sentence}`);
      }
    });
  }

  it('fullstack.agent.md states the required-when-targeted contract as a re-verified claim', async () => {
    const text = await normalized('agents/fullstack.agent.md');
    assert.ok(text.includes('Required whenever your dispatch payload has a "Target acceptance criteria" section'), text.slice(0, 200));
    assert.ok(text.includes('Omitting the key when ACs were targeted is a contract violation'));
    assert.ok(text.includes('Only a dispatch with no AC targets may omit the key.'));
    assert.ok(/claim.* the harness re-verifies/.test(text));
  });
});
