// @ts-check
/**
 * END-TO-END: the human-gate protocol under NON-happy input.
 *
 * The happy path — a human types the exact approval phrase at exactly the right
 * gate — is covered elsewhere. What was never covered is everything a real human
 * actually does at a decision gate: approve the WRONG artifact, approve at the
 * wrong TIME, reject and revise in a loop, ask a question, change their mind
 * AFTER approving, or type an approval with a trailing afterthought. Each of
 * those must do exactly one of two things — advance the gate it legally can, or
 * refuse and SAY SO on the channel the model reads — and must never wedge the
 * workflow or silently pretend a gate moved.
 *
 * ## Why this suite drives the real hooks
 *
 * Every assertion below runs `hooks/approval-listener.mjs` (and, for the
 * post-approval rollback, `hooks/spec-integrity-guard.mjs`) as a REAL subprocess
 * through the harness, with the payload the VS Code host actually delivers on
 * stdin and the workspace's own `.devmate/` as cwd. The oracle is the state that
 * lands on disk (`task.json`, the JSONL trace, `turn-intent.json`) and the single
 * JSON envelope the hook writes to stdout — never a mirror of the hook's own
 * transition table. A test that re-encoded the table would pass against a hook
 * that had stopped calling it.
 *
 * ## The one thing the host reads on stdout
 *
 * `hooks/approval-listener.mjs` prints a human-readable `<devmate-state>` anchor
 * AND, when it refuses, a JSON guidance line — then `main()` wraps the WHOLE
 * concatenated text as ONE `additionalContext` string (lib/hooks/output-schema.mjs
 * `writeHookOutput`: mixed text is not a single JSON document, so it is enveloped
 * wholesale). So the model-visible text is a substring of `additionalContext`,
 * and that is what {@link additionalContextOf} extracts and every guidance
 * assertion searches.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { hooksFor, readState, readTraceEvents, seedMonorootWorkspace, spawnHook } from './session-harness.mjs';

/** Stable task id every seeded workspace carries, so trace paths are predictable. */
const TASK_ID = 'task-3-hgp';

/**
 * The spec a human is reviewing at the spec gate. Carries the three sections a
 * real `spec.md` has (`## Acceptance criteria`, `## Files that will change` with a
 * backticked path, `## Out of scope`) so the feature-lane continuation can read a
 * file list and the spec-approved precondition finds a non-empty spec.
 * @type {string}
 */
const SPEC_CONTENT = [
  '# Spec',
  '',
  '## Acceptance criteria',
  '',
  '1. User can log in with JWT',
  '',
  '## Files that will change',
  '',
  '- `repo-a/lib/auth.mjs` (new) — auth',
  '',
  '## Out of scope',
  '',
  '- SSO',
  '',
].join('\n');

/**
 * SHA-256 of a spec's utf8 bytes, matching how spec-writer records `specDigest`
 * and how spec-integrity-guard re-hashes the file on a post-approval edit.
 * @param {string} content
 * @returns {string}
 */
function specDigest(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * @typedef {ReturnType<typeof seedMonorootWorkspace>} Workspace
 */

/**
 * Seed a workspace whose task sits at a given gate, with a valid `task.json` and
 * (optionally) the spec on disk. Nothing about the WORKFLOW is faked — the real
 * hooks read this exactly as they would a session that arrived here on its own;
 * only the arrival is short-cut, so each scenario starts at the gate it targets.
 * @param {{ gate: string, lane?: 'feature'|'bug'|'chore', withSpec?: boolean }} opts
 * @returns {{ ws: Workspace, digest: string }}
 */
function seedAtGate({ gate, lane = 'feature', withSpec = true }) {
  const ws = seedMonorootWorkspace();
  mkdirSync(join(ws.root, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(ws.root, '.devmate', 'session'), { recursive: true });

  const digest = specDigest(SPEC_CONTENT);
  const state = {
    taskId: TASK_ID,
    lane,
    workflowGate: gate,
    artifactHashes: withSpec ? { spec: '.devmate/session/spec.md', specDigest: digest } : {},
    preImplStash: null,
    currentStep: 0,
    budget: 25,
    schemaVersion: 1,
    specFiles: ['repo-a/lib/auth.mjs'],
    acceptanceCriteria: ['User can log in with JWT'],
  };
  writeFileSync(join(ws.root, '.devmate', 'state', 'task.json'), JSON.stringify(state, null, 2));
  if (withSpec) writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), SPEC_CONTENT);
  return { ws, digest };
}

/** The single hook registered for UserPromptSubmit (asserted below). */
const [PROMPT_HOOK] = hooksFor('UserPromptSubmit');

/**
 * Submit one user prompt through the REAL UserPromptSubmit hook, exactly as the
 * host would — payload on stdin, cwd = the workspace's own `.devmate/`.
 * @param {Workspace} ws
 * @param {string} prompt
 * @returns {{ script: string, status: number, stdout: string, stderr: string }}
 */
function submitPrompt(ws, prompt) {
  const payload = { hook_event_name: 'UserPromptSubmit', prompt, cwd: ws.hostCwd };
  return spawnHook(PROMPT_HOOK.script, PROMPT_HOOK.args, payload, ws.hostCwd);
}

/**
 * The model-visible text: the `additionalContext` string the hook enveloped, or
 * '' when the hook wrote nothing / stdout was not the expected envelope.
 * @param {{ stdout: string }} result
 * @returns {string}
 */
function additionalContextOf(result) {
  const trimmed = result.stdout.trim();
  if (trimmed === '') return '';
  try {
    const json = JSON.parse(trimmed);
    const ctx = json?.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' ? ctx : '';
  } catch {
    return '';
  }
}

/**
 * The gate `task.json` currently names.
 * @param {Workspace} ws
 * @returns {string}
 */
function gateOf(ws) {
  return readState(ws.root).workflowGate;
}

/**
 * Trace events for the seeded task, or [] when no trace file exists yet.
 * @param {Workspace} ws
 * @returns {Record<string, any>[]}
 */
function traceOf(ws) {
  const file = join(ws.root, '.devmate', 'state', 'trace', `${TASK_ID}.jsonl`);
  return existsSync(file) ? readTraceEvents(file) : [];
}

/**
 * The deterministic turn-intent verdict the hook persists on every prompt, or
 * null when it was not written.
 * @param {Workspace} ws
 * @returns {Record<string, any>|null}
 */
function turnIntentOf(ws) {
  const file = join(ws.root, '.devmate', 'state', 'turn-intent.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/**
 * The raw utf8 bytes of this task's `task.json`, for byte-identical comparison.
 * Defined at module scope so the read is not a resource allocation inside a loop.
 * @param {Workspace} ws
 * @returns {string}
 */
function readTaskJsonRaw(ws) {
  return readFileSync(join(ws.root, '.devmate', 'state', 'task.json'), 'utf8');
}

// The three canonical approval phrases a human might type at ANY gate.
const PHRASES = /** @type {const} */ (['approve spec', 'approve pr', 'approve plan']);

/**
 * The wrong-gate matrix. For each (lane, gate) the human might sit at, the gate
 * each phrase LEGALLY reaches — empirically confirmed against the real hook, not
 * copied from a transition table. A phrase absent from a cell's `advances` map is
 * illegal there and must be REFUSED with model-visible guidance (gate unchanged).
 *
 * `friendlyNoop` marks a phrase that is a no-op WITHOUT a "did not advance"
 * refusal, because the gate is already where the phrase would take it (the hook's
 * idempotent branches: "approve pr" at pr-ready). `friendlyHints` carries, per
 * such phrase, the POSITIVE idempotent guidance the hook must surface — so a
 * no-op is proven to CONFIRM the already-there state, not merely stay silent.
 * @type {{ lane: 'feature'|'bug', gate: string, advances: Record<string, string>, friendlyNoop?: string[], friendlyHints?: Record<string, RegExp> }[]}
 */
const WRONG_GATE_MATRIX = [
  { lane: 'feature', gate: 'no-lane', advances: {} },
  { lane: 'feature', gate: 'lane-set', advances: {} },
  { lane: 'feature', gate: 'plan-approved', advances: {} },
  { lane: 'bug', gate: 'plan-approved', advances: { 'approve plan': 'impl-started' } },
  { lane: 'feature', gate: 'spec-draft', advances: { 'approve spec': 'impl-started' } },
  {
    lane: 'feature',
    gate: 'spec-approved',
    advances: { 'approve spec': 'impl-started', 'approve plan': 'impl-started' },
  },
  { lane: 'feature', gate: 'verification-passed', advances: { 'approve pr': 'pr-ready' } },
  {
    lane: 'feature',
    gate: 'pr-ready',
    advances: {},
    friendlyNoop: ['approve pr'],
    friendlyHints: { 'approve pr': /pr is already marked ready/i },
  },
];

describe('E2E — human gate protocol: wrong-gate approval matrix', { concurrency: false }, () => {
  it('registers exactly one UserPromptSubmit hook (the approval listener)', () => {
    assert.equal(hooksFor('UserPromptSubmit').length, 1);
    assert.match(PROMPT_HOOK.script.replace(/\\/g, '/'), /hooks\/approval-listener\.mjs$/);
  });

  for (const cell of WRONG_GATE_MATRIX) {
    for (const phrase of PHRASES) {
      const legalTo = cell.advances[phrase];
      const friendly = (cell.friendlyNoop ?? []).includes(phrase);
      const friendlyHint = cell.friendlyHints?.[phrase];
      const verb = legalTo ? `advances to ${legalTo}` : friendly ? 'is a friendly no-op' : 'is refused with guidance';

      it(`${cell.lane}/${cell.gate}: "${phrase}" ${verb}`, { timeout: 30000 }, () => {
        const { ws } = seedAtGate({ gate: cell.gate, lane: cell.lane });
        const result = submitPrompt(ws, phrase);

        // The hook must NEVER block a prompt: exit 0, no thrown handler on stderr.
        assert.equal(result.status, 0, `non-zero exit ${result.status}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /handler failed/i, `the handler threw: ${result.stderr}`);

        const ctx = additionalContextOf(result);

        if (legalTo) {
          assert.equal(gateOf(ws), legalTo, `expected legal advance to ${legalTo}`);
          assert.doesNotMatch(ctx, /did not advance the gate/i, 'a legal advance must not emit a refusal');
        } else {
          // Illegal or friendly: the gate must NOT have moved.
          assert.equal(gateOf(ws), cell.gate, 'an illegal/no-op phrase moved the gate');
          if (friendly) {
            assert.doesNotMatch(ctx, /did not advance the gate/i, 'a friendly no-op must not read as a refusal');
            // A no-op must POSITIVELY confirm the idempotent state, not stay silent.
            assert.ok(friendlyHint, `no friendlyHint declared for the no-op "${phrase}" at ${cell.gate}`);
            assert.match(ctx, friendlyHint, 'a friendly no-op did not surface its idempotent guidance');
          } else {
            // The refusal must be visible AND carry the legal next gates ON ITS
            // OWN line — not merely somewhere in the enveloped text, where the
            // always-on <devmate-state> anchor also prints "legal next gates:".
            // Scoping to the refusal line proves the guidance itself names them.
            assert.match(ctx, /did not advance the gate/i, 'an illegal approval was silently ignored');
            assert.match(
              ctx,
              /did not advance the gate:[^\n]*legal next gates:/i,
              'the refusal line itself did not surface the legal next gates (only the anchor may have)',
            );
          }
        }
      });
    }
  }
});

describe('E2E — human gate protocol: rejection & revision loops', { concurrency: false }, () => {
  it('three revise-spec cycles keep the gate at spec-draft and record verbatim feedback', () => {
    const { ws } = seedAtGate({ gate: 'spec-draft' });
    const feedback = 'use JWT not sessions';

    for (let i = 0; i < 3; i++) {
      const result = submitPrompt(ws, `revise spec: ${feedback}`);
      assert.equal(result.status, 0, `cycle ${i}: non-zero exit ${result.status}: ${result.stderr}`);
      // The gate never moves on a revision — the spec stays under human review.
      assert.equal(gateOf(ws), 'spec-draft', `cycle ${i}: revision moved the gate`);
    }

    const revisions = traceOf(ws).filter((e) => e.type === 'spec_revision_requested');
    assert.equal(revisions.length, 3, 'expected one spec_revision_requested per cycle');
    for (const ev of revisions) {
      assert.equal(ev.feedback, feedback, 'feedback was not recorded verbatim');
      assert.equal(ev.taskId, TASK_ID, 'the revision is not bound to this task');
    }

    // No rollback/invalidation fired — a revision is not an edit to the artifact.
    assert.equal(traceOf(ws).filter((e) => e.type === 'spec_invalidated').length, 0);
  });

  it('carries the human\'s exact words even when they contain punctuation and colons', () => {
    const { ws } = seedAtGate({ gate: 'spec-draft' });
    const feedback = 'drop OAuth; use JWT (RS256), TTL: 15m';
    const result = submitPrompt(ws, `revise spec: ${feedback}`);

    assert.equal(result.status, 0);
    assert.equal(gateOf(ws), 'spec-draft');
    const revisions = traceOf(ws).filter((e) => e.type === 'spec_revision_requested');
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].feedback, feedback, 'feedback after the first colon must be preserved verbatim');
  });
});

describe('E2E — human gate protocol: free-form & ambiguous input defers', { concurrency: false }, () => {
  for (const prompt of ['actually it should also handle SSO', 'hmm ok I guess?']) {
    it(`"${prompt}" at spec-draft defers to the LLM stage and never advances`, () => {
      const { ws } = seedAtGate({ gate: 'spec-draft' });
      const result = submitPrompt(ws, prompt);

      assert.equal(result.status, 0, `non-zero exit ${result.status}: ${result.stderr}`);
      assert.equal(gateOf(ws), 'spec-draft', 'a deferred turn must not move the gate');

      const intent = turnIntentOf(ws);
      assert.ok(intent, 'turn-intent.json was not written');
      assert.equal(intent.deferred, true, 'the deterministic fast path did not defer this ambiguous turn');
      assert.equal(intent.intent, null, 'a deferred turn must carry a null intent');
      assert.equal(intent.gate, 'spec-draft', 'the deferral was recorded against the wrong gate');
    });
  }
});

describe('E2E — human gate protocol: questions & status are strictly read-only', { concurrency: false }, () => {
  const readOnlyGates = /** @type {const} */ ([
    { lane: 'feature', gate: 'spec-draft' },
    { lane: 'feature', gate: 'verification-passed' },
    { lane: 'bug', gate: 'plan-approved' },
  ]);

  for (const { lane, gate } of readOnlyGates) {
    for (const prompt of ['which file does the spec live in?', 'what is the current status?']) {
      it(`${lane}/${gate}: "${prompt}" leaves task.json byte-identical and writes no trace`, () => {
        const { ws } = seedAtGate({ gate, lane });
        const before = readTaskJsonRaw(ws);

        const result = submitPrompt(ws, prompt);

        assert.equal(result.status, 0, `non-zero exit ${result.status}: ${result.stderr}`);
        assert.equal(readTaskJsonRaw(ws), before, 'a question mutated task.json');
        assert.equal(traceOf(ws).length, 0, 'a question wrote a trace event');
      });
    }
  }
});

describe('E2E — human gate protocol: post-approval regret rolls back, then re-approval works', { concurrency: false }, () => {
  /** @type {Workspace} */
  let ws;

  /** The spec-integrity-guard, located through the REAL PostToolUse manifest. */
  const guard = hooksFor('PostToolUse').find((h) =>
    h.script.replace(/\\/g, '/').endsWith('hooks/spec-integrity-guard.mjs'),
  );

  before(() => {
    ({ ws } = seedAtGate({ gate: 'spec-approved' }));
  });

  it('the guard is registered on PostToolUse', () => {
    assert.ok(guard, 'spec-integrity-guard is not registered on PostToolUse');
  });

  it('a post-approval edit to spec.md rolls the gate spec-approved -> spec-draft with an audit pair', () => {
    // The regret: the human edits the approved spec on disk. Its digest now
    // diverges from the one recorded at approval.
    assert.ok(guard, 'spec-integrity-guard is not registered on PostToolUse');
    const specAbs = join(ws.root, '.devmate', 'session', 'spec.md');
    writeFileSync(specAbs, `${SPEC_CONTENT}\n- also support SSO after all\n`);

    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'applyPatch',
      tool_input: { filePath: specAbs },
      tool_response: '',
      cwd: ws.hostCwd,
    };
    const result = spawnHook(guard.script, guard.args, payload, ws.hostCwd);
    assert.equal(result.status, 0, `guard exited ${result.status}: ${result.stderr}`);

    assert.equal(gateOf(ws), 'spec-draft', 'the post-approval edit did not roll the gate back');

    const trace = traceOf(ws);
    assert.ok(
      trace.some((e) => e.type === 'spec_invalidated'),
      `no spec_invalidated event: ${trace.map((e) => e.type).join(', ')}`,
    );
    const rollback = trace.find(
      (e) => e.type === 'gate_transition' && e.from === 'spec-approved' && e.to === 'spec-draft',
    );
    assert.ok(rollback, 'no gate_transition recorded the spec-approved -> spec-draft rollback');
  });

  it('a revise-spec after rollback records feedback WITHOUT moving the gate', () => {
    const result = submitPrompt(ws, 'revise spec: keep it session-free');
    assert.equal(result.status, 0);
    assert.equal(gateOf(ws), 'spec-draft', 'revise-spec must not move the gate after a rollback');
    assert.ok(
      traceOf(ws).some((e) => e.type === 'spec_revision_requested' && e.feedback === 'keep it session-free'),
    );
  });

  it('re-approving the rolled-back spec advances the workflow again', () => {
    const result = submitPrompt(ws, 'approve spec');
    assert.equal(result.status, 0, `re-approval exited ${result.status}: ${result.stderr}`);
    // The rollback refreshed the recorded digest to the edited spec, so a plain
    // re-approval is legal and the feature lane continues into implementation.
    assert.equal(gateOf(ws), 'impl-started', 're-approval did not resume the workflow');
  });
});

describe('E2E — human gate protocol: an approval with trailing prose does NOT approve', { concurrency: false }, () => {
  // DECISION (pinned): the deterministic layer approves only the EXACT phrase.
  // "approve spec — but rename the module later" is not that phrase, so the hook
  // does not advance the gate; it emits a near-miss hint and defers the turn to
  // the LLM stage. Both layers agree on this phrasing: the gate-robustness eval's
  // Stage-2 proxy (evals/gate-robustness/scorer.mjs) also classifies it as
  // revise-artifact — a change deferred to "later" is still a pending change, so
  // default-to-revision keeps it at spec-draft. Neither the deterministic Stage 1
  // nor the interpreted Stage 2 ever auto-advances devmate's one human checkpoint
  // on a trailing afterthought; the ambiguity reaches a human/LLM instead of
  // silently opening implementation. (See the hgp-trailing-prose-approval case in
  // fixtures/revisions.json, driven verbatim by this suite.)
  it('emits a near-miss hint, defers the turn, and leaves the gate at spec-draft', () => {
    const { ws } = seedAtGate({ gate: 'spec-draft' });
    const result = submitPrompt(ws, 'approve spec — but rename the module later');

    assert.equal(result.status, 0, `non-zero exit ${result.status}: ${result.stderr}`);
    assert.equal(gateOf(ws), 'spec-draft', 'trailing prose must not advance the gate');

    const ctx = additionalContextOf(result);
    assert.match(ctx, /Did you mean: approve spec\?/i, 'no near-miss hint was surfaced');

    const intent = turnIntentOf(ws);
    assert.ok(intent, 'turn-intent.json was not written');
    assert.equal(intent.deferred, true, 'trailing-prose approval must defer to the LLM stage');
  });
});
