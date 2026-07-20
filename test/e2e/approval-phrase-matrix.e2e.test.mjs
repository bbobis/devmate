// @ts-check
/**
 * END-TO-END: the approval-phrase safety matrix (issue #137).
 *
 * The systematic counterpart to #123's one-off crash fix. Instead of proving one
 * phrase is safe at one illegal gate, this drives EVERY approval-adjacent phrase
 * through the real UserPromptSubmit hook at EVERY reachable (lane, gate) — legal
 * or not — and asserts the same three properties every cell owes:
 *
 *   1. The hook never throws: exit is always 0 (the only non-blocking success
 *      code for UserPromptSubmit; a thrown handler would exit 1).
 *   2. Stdout is always exactly one valid JSON document (or empty), never a torn
 *      or mixed payload the host would drop whole.
 *   3. The gate moves ONLY when the edge is genuinely legal, and when it does not
 *      move the model is still told something actionable — never a silent no-op.
 *
 * This is GREEN by construction after #123/#124/#125/#127/#130: those are exactly
 * what made every phrase branch degrade to a message instead of a crash. A cell
 * that exits non-zero, emits non-JSON, or advances to an illegal gate is a real
 * regression this matrix exists to catch.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { legalTransitions, reachableGates } from '../../lib/gate-transitions.mjs';
import { markSessionForFile } from '../../lib/test-utils/hook-session.mjs';
import { hooksFor, readState, seedMonorootWorkspace, spawnHook } from './session-harness.mjs';

/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

// Enforcement is session-scoped; mark one session for the whole file so the real
// hooks run inside an active devmate session.
const SESSION_ID = markSessionForFile('devmate-test-phrase-matrix');
const TASK_ID = 'task-137-matrix';

/** A real spec.md so the feature spec-gate cells can actually advance. */
const SPEC_CONTENT = [
  '# Spec', '', '## Acceptance criteria', '', '1. User can log in with JWT', '',
  '## Files that will change', '', '- `repo-a/lib/auth.mjs` (new) — auth', '',
  '## Out of scope', '', '- SSO', '',
].join('\n');

/** @param {string} content @returns {string} */
function digestOf(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** @typedef {ReturnType<typeof seedMonorootWorkspace>} Workspace */

/**
 * Seed a workspace standing at (lane, gate) with a valid task.json plus the spec
 * on disk — the arrival is short-cut, but the hooks read it exactly as a real
 * session that reached this gate on its own.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {Workspace}
 */
function seedAtGate(lane, gate) {
  const ws = seedMonorootWorkspace();
  mkdirSync(join(ws.root, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(ws.root, '.devmate', 'session', TASK_ID), { recursive: true });
  const state = {
    taskId: TASK_ID,
    lane,
    workflowGate: gate,
    artifactHashes: { spec: '.devmate/session/spec.md', specDigest: digestOf(SPEC_CONTENT) },
    preImplStash: null,
    currentStep: 0,
    budget: 25,
    schemaVersion: 1,
    specFiles: ['repo-a/lib/auth.mjs'],
    acceptanceCriteria: ['User can log in with JWT'],
  };
  writeFileSync(join(ws.root, '.devmate', 'state', 'task.json'), JSON.stringify(state, null, 2), 'utf8');
  writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), SPEC_CONTENT, 'utf8');
  // A scope contract, so the bug/chore plan-approved cells can advance too.
  writeFileSync(
    join(ws.root, '.devmate', 'session', TASK_ID, 'scope.md'),
    ['# Scope', '', '## Allowed paths', '- repo-a/lib/auth.mjs', ''].join('\n'),
    'utf8',
  );
  return ws;
}

const [PROMPT_HOOK] = hooksFor('UserPromptSubmit');

/**
 * Submit one prompt through the real UserPromptSubmit hook subprocess.
 * @param {Workspace} ws
 * @param {string} prompt
 * @returns {ReturnType<typeof spawnHook>}
 */
function submitPrompt(ws, prompt) {
  return spawnHook(
    PROMPT_HOOK.script,
    PROMPT_HOOK.args,
    { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt, cwd: ws.hostCwd },
    ws.hostCwd,
  );
}

/**
 * The model-visible `additionalContext` string, or '' when stdout is empty or not
 * the expected single-envelope shape.
 * @param {{ stdout: string }} r
 * @returns {string}
 */
function additionalContextOf(r) {
  const trimmed = r.stdout.trim();
  if (trimmed === '') return '';
  try {
    const ctx = JSON.parse(trimmed)?.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' ? ctx : '';
  } catch {
    return '';
  }
}

/** The six approval-adjacent phrases (post #125/#127/#130). */
const PHRASES = /** @type {const} */ ([
  'approve spec',
  'approve plan',
  'approve pr',
  'revise spec: tighten the auth flow',
  'approve no-tdd reason="spike"',
  'escalate chore to feature: scope grew',
]);

const LANES = /** @type {Lane[]} */ (['feature', 'bug', 'chore']);

/**
 * Every reachable (lane, gate). `reachableGates` is the canonical enumerator
 * (#132); feature `plan-approved` is added by hand because the lane reaches it
 * only via a chore escalation, so BFS from no-lane omits it — but it is a real
 * runtime gate where `approve plan` must refuse (HITL-2), worth covering.
 * @type {{ lane: Lane, gate: WorkflowGate }[]}
 */
const CELLS = [];
for (const lane of LANES) {
  for (const gate of reachableGates(lane)) CELLS.push({ lane, gate });
}
CELLS.push({ lane: 'feature', gate: 'plan-approved' });

for (const { lane, gate } of CELLS) {
  describe(`E2E phrase-matrix — ${lane}/${gate}`, () => {
    for (const phrase of PHRASES) {
      it(`"${phrase}" is exit-0, single-JSON, and actionable`, () => {
        const ws = seedAtGate(lane, gate);
        try {
          const before = readState(ws.root).workflowGate;
          const r = submitPrompt(ws, phrase);

          // 1. Never throws.
          assert.equal(r.status, 0, `non-zero exit at ${lane}/${gate} for "${phrase}":\n${r.stderr}`);
          assert.doesNotMatch(r.stderr, /handler failed/i, `a thrown handler at ${lane}/${gate} for "${phrase}"`);
          // 2. Stdout is empty or exactly one JSON document.
          const trimmed = r.stdout.trim();
          if (trimmed !== '') {
            assert.doesNotThrow(() => JSON.parse(trimmed), `stdout is not single JSON at ${lane}/${gate} for "${phrase}": ${trimmed.slice(0, 120)}`);
          }
          // 3. Move only on a genuine edge; otherwise say something actionable.
          const afterState = readState(ws.root);
          const after = /** @type {WorkflowGate} */ (afterState.workflowGate);
          const moved = after !== before || afterState.lane !== lane;
          if (!moved) {
            assert.notEqual(additionalContextOf(r), '', `${lane}/${gate} held for "${phrase}" but the model was told nothing`);
            // #176 FIXED: "approve pr" at chore/verification-passed no longer walks
            // into pr-ready — the handler now accepts approve-pr only where it is the
            // lane's designated phrase (the #125 anchor's own predicate), so this
            // cell HOLDS and refuses with an actionable message naming the chore
            // lane's verified terminal.
            if (lane === 'chore' && before === 'verification-passed' && phrase === 'approve pr') {
              assert.equal(after, 'verification-passed', '#176 — the chore gate must not move on approve pr');
              const ctx = additionalContextOf(r);
              // Require the terminal gate NAMED explicitly (not an OR with pr-ready,
              // which a "walks to pr-ready" message could satisfy) AND the refusal
              // semantics — so a regression to the walk fails here.
              assert.match(ctx, /verification-passed/, '#176 — the refusal must name the chore terminal gate');
              assert.match(ctx, /does not apply|never enters pr-ready/, '#176 — the message must read as a refusal, not a walk');
            }
          } else if (lane === 'chore' && phrase.startsWith('escalate chore to feature')) {
            // The escalate phrase switches an in-flight CHORE into the feature lane
            // at plan-approved — a documented lane transition (#130), not a same-lane
            // gate advance. Guarded to lane === 'chore': a non-chore task must never
            // escalate, so if one moved it falls through to the illegal-advance check.
            assert.equal(afterState.lane, 'feature', `escalate must land on the feature lane, got ${afterState.lane}`);
            assert.equal(after, 'plan-approved', `escalate re-enters at plan-approved, got ${after}`);
          } else {
            assert.equal(afterState.lane, lane, `unexpected lane change ${lane} -> ${afterState.lane} for "${phrase}"`);
            // The one legitimate multi-hop advance: "approve spec" at feature
            // spec-draft chains spec-draft -> spec-approved -> impl-started via
            // continueApprovedFeature. Every other advance must be a single legal edge
            // (no blanket impl-started escape, which would mask an illegal jump).
            const continuation = lane === 'feature' && before === 'spec-draft' && after === 'impl-started';
            const legal = legalTransitions(lane, before).includes(after) || continuation;
            assert.ok(legal, `illegal advance ${before} -> ${after} at ${lane} for "${phrase}"`);
          }
        } finally {
          rmSync(ws.root, { recursive: true, force: true });
        }
      });
    }
  });
}
