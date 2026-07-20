// @ts-check
/**
 * END-TO-END: concurrent sessions on one workspace, and a commit failure during
 * a gate-advancing write (issue #136).
 *
 * `TaskState` (lib/types.mjs) carries NO session/chat identifier — `.devmate/state/task.json`
 * is a single flat file with one `lane`/`workflowGate`/`currentStep`. So two forked
 * chat sessions over one workspace share and race on that file. This suite proves:
 *
 *   1. Two `UserPromptSubmit` hooks racing on one task.json (genuinely concurrent
 *      subprocesses — an async spawn, not blocking `spawnSync` in a `Promise.all`
 *      that would serialize) cannot torn-write or lose the gate: the file stays
 *      valid and lands one coherent outcome.
 *   2. A double `"approve plan"` race advances the gate to exactly `impl-started`,
 *      idempotently — never a double-transition to a wrong gate, never corruption.
 *      The winner is inherently nondeterministic (the read-modify-write is not
 *      atomic across the write lock), so the assertion is the INVARIANT (final gate
 *      + every trace advance is the one legal edge), never a winner or an exact
 *      line count.
 *   3. A commit failure during the gate write (the atomic tmp-write is forced to
 *      fail) leaves task.json at the PRE-write gate — never "the user saw
 *      'approved' but the gate never moved" — and the failure is surfaced, not
 *      swallowed.
 *
 * `writeTaskState` serializes writes with a cross-process `withFileLock` (O_EXCL)
 * and an atomic tmp+rename, so task.json itself never flakes. The unlocked side
 * files two racers both touch (turn-intent, skill-matches, domain-context) are
 * best-effort (try/catch → stderr warning only), so this suite deliberately does
 * NOT assert on them — only on task.json and the per-task trace.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { validateTaskState } from '../../lib/task-state.mjs';
import { markDevmateSession } from '../../lib/hooks/session-marker.mjs';
import { getOwn } from '../../lib/object-utils.mjs';
import {
  DEFAULT_SESSION_ID,
  REPO_ROOT,
  readState,
  readTraceEvents,
  replaySession,
  seedMonorootWorkspace,
} from './session-harness.mjs';

const SESSION_ID = DEFAULT_SESSION_ID;

/**
 * Seed a fresh monoroot workspace and bootstrap a valid task.json via SessionStart.
 * @returns {ReturnType<typeof seedMonorootWorkspace>}
 */
function boot() {
  const ws = seedMonorootWorkspace();
  replaySession(
    [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
    ws.hostCwd,
  );
  return ws;
}

/**
 * Stand the bootstrapped task at (lane, plan-approved) with the scope contract
 * `impl-started` requires (#92), so a `"approve plan"` phrase can advance it.
 * `currentStep` is non-zero so the transitionGate reset to 0 is observable.
 * @param {string} root
 * @param {'bug'|'chore'} lane
 * @returns {string} taskId
 */
function seedPlanApproved(root, lane) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  const state = readState(root);
  writeFileSync(
    statePath,
    JSON.stringify({ ...state, lane, workflowGate: 'plan-approved', currentStep: 7 }),
    'utf8',
  );
  const sessionDir = join(root, '.devmate', 'session', state.taskId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'scope.md'),
    ['---', `lane: ${lane}`, '---', '# Scope', '', '## Allowed paths', '- src/app.mjs', '', '## Allowed globs', ''].join('\n'),
    'utf8',
  );
  return state.taskId;
}

/**
 * @typedef {{ script: string, status: number, signal: string|null, stdout: string, stderr: string }} HookRun
 */

/**
 * The async twin of the harness's blocking `spawnHook`: it starts the child and
 * returns a promise, so two calls inside one `Promise.all` genuinely overlap
 * (both children are live before either resolves) — the only way to race real
 * subprocesses. Replicates `spawnHook`'s up-front `markDevmateSession` so runtime
 * scoping keeps enforcement live in the child.
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, unknown>} payload
 * @param {string} cwd
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {Promise<HookRun>}
 */
function spawnHookAsync(script, args, payload, cwd, opts = {}) {
  const sid = getOwn(payload ?? {}, 'session_id');
  if (typeof sid === 'string' && sid !== '') markDevmateSession(sid, 'router');

  return new Promise((resolve) => {
    const child = spawn('node', [join(REPO_ROOT, script), ...args], {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    /** @param {HookRun} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A hung child must never hang the runner — kill and resolve, mirroring
    // spawnHook's spawnSync timeout (session-harness.mjs).
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ script, status: 1, signal: 'SIGKILL', stdout, stderr: `${stderr}\n[spawnHookAsync] timeout` });
    }, opts.timeoutMs ?? 20000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // A spawn failure emits 'error' and may never emit 'close' — resolve so the
    // test fails on an assertion, never hangs.
    child.on('error', (err) => finish({ script, status: 1, signal: null, stdout, stderr: stderr + String(err?.message ?? err) }));
    child.on('close', (status, signal) => finish({ script, status: status ?? 1, signal: signal ?? null, stdout, stderr }));
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits before reading stdin
    child.stdin.write(JSON.stringify({ ...payload, cwd }));
    child.stdin.end();
  });
}

/**
 * A UserPromptSubmit payload for the approval listener.
 * @param {string} prompt
 * @returns {Record<string, unknown>}
 */
function promptPayload(prompt) {
  return { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt };
}

/**
 * Every `gate_transition` line landing on `impl-started` in the task's trace.
 * A missing trace file means zero advances — the correct reading when a failed
 * gate write never got as far as recording anything.
 * @param {string} root
 * @param {string} taskId
 * @returns {Record<string, any>[]}
 */
function implStartedAdvances(root, taskId) {
  const trace = join(root, '.devmate', 'state', 'trace', `${taskId}.jsonl`);
  if (!existsSync(trace)) return [];
  const events = readTraceEvents(trace); // throws on a torn/partial JSONL line
  return events.filter((e) => e.type === 'gate_transition' && e.to === 'impl-started');
}

// ── Scenario 1: an approve-plan racing an ordinary prompt ────────────────────

describe('E2E concurrency — "approve plan" racing an ordinary prompt lands one coherent outcome', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {HookRun} */
  let approveRun;

  before(async () => {
    ws = boot();
    taskId = seedPlanApproved(ws.root, 'bug');
    // One real racer approves the plan; the other is unrelated chatter that matches
    // no phrase. Both fire concurrently against the one task.json.
    [approveRun] = await Promise.all([
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('approve plan'), ws.hostCwd),
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('what does this repo do?'), ws.hostCwd),
    ]);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('leaves task.json valid and at one coherent gate — never a torn or wrong-gate write', () => {
    const raw = readFileSync(join(ws.root, '.devmate', 'state', 'task.json'), 'utf8');
    const state = JSON.parse(raw); // must not throw — atomic rename guarantees a whole file
    assert.equal(validateTaskState(state).ok, true);
    // The approve-plan write either won (advanced) or lost a transient write race
    // (e.g. the ordinary session's unlocked read holding the file open across the
    // atomic rename — the Windows EPERM class #136 names). Either way the state is
    // coherent: exactly one of the two valid gates, never a torn or wrong one.
    assert.ok(['impl-started', 'plan-approved'].includes(state.workflowGate), `unexpected gate ${state.workflowGate}`);
  });

  it('the gate and its trace agree, and a lost write is surfaced — never silent data loss', () => {
    const state = readState(ws.root);
    const advances = implStartedAdvances(ws.root, taskId);
    // Whichever way the race went, no advance is ever the ordinary prompt's, and
    // none walks to a wrong gate — only the phrase can write the one legal edge.
    for (const a of advances) {
      assert.equal(a.from, 'plan-approved');
      assert.equal(a.to, 'impl-started');
      assert.equal(a.evidence, 'approve plan');
    }
    if (state.workflowGate === 'impl-started') {
      assert.equal(advances.length, 1, 'an advanced gate has exactly one recorded advance');
      assert.equal(state.currentStep, 0, 'transitionGate reset currentStep');
      // The winner CLEARLY won — it reported success, not a non-zero exit.
      assert.equal(approveRun.status, 0, `the winning approve-plan turn must report success:\n${approveRun.stderr}`);
    } else {
      // The write lost the race — that MUST be a surfaced failure, not a silent
      // no-op: the gate stayed put AND the approve-plan turn reported non-zero.
      assert.equal(advances.length, 0, 'a non-advanced gate records no advance');
      assert.notEqual(approveRun.status, 0, `a lost approve-plan write must surface:\n${approveRun.stdout}${approveRun.stderr}`);
    }
  });
});

// ── Scenario 2: a double approve-plan race ───────────────────────────────────

describe('E2E concurrency — a double "approve plan" race advances once, coherently, never corrupts', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(async () => {
    ws = boot();
    taskId = seedPlanApproved(ws.root, 'bug');
    await Promise.all([
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('approve plan'), ws.hostCwd),
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('approve plan'), ws.hostCwd),
    ]);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('lands a valid task.json at exactly impl-started, regardless of which racer won', () => {
    const raw = readFileSync(join(ws.root, '.devmate', 'state', 'task.json'), 'utf8');
    const state = JSON.parse(raw);
    assert.equal(validateTaskState(state).ok, true);
    assert.equal(state.workflowGate, 'impl-started');
    assert.equal(state.currentStep, 0);
  });

  it('every trace advance is the SAME legal plan-approved -> impl-started edge (1 or 2, never a wrong gate)', () => {
    // The read-modify-write is not atomic across the write lock, so both racers
    // may read plan-approved and both write the (identical, idempotent) advance:
    // 1 line (one read impl-started first) or 2 lines (both read plan-approved).
    // Both are coherent; a torn write or a wrong-gate line would not be.
    const advances = implStartedAdvances(ws.root, taskId);
    assert.ok(advances.length >= 1 && advances.length <= 2, `unexpected advance count ${advances.length}`);
    for (const a of advances) {
      assert.equal(a.from, 'plan-approved');
      assert.equal(a.to, 'impl-started');
      assert.equal(a.actor, 'hook-exact-phrase');
      assert.equal(a.evidence, 'approve plan');
    }
  });
});

// ── Scenario 3: a commit failure during the gate write ───────────────────────

describe('E2E concurrency — a failed commit during a gate write leaves the PRE-write gate, surfaced', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {HookRun} */
  let ran;

  before(async () => {
    ws = boot();
    taskId = seedPlanApproved(ws.root, 'bug');
    // Force the atomic commit to fail deterministically: a directory where the
    // tmp file must be written makes writeTextFileSync throw EISDIR inside the
    // write lock (the house pattern — failure-injection.e2e.test.mjs suite 7 —
    // needs no production seam and is cross-platform). The transition is computed
    // but never persisted, and recordGateTransition never runs.
    mkdirSync(join(ws.root, '.devmate', 'state', 'task.json.tmp'), { recursive: true });
    ran = await spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('approve plan'), ws.hostCwd);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('task.json still holds plan-approved — the gate never claims a move it did not persist', () => {
    const raw = readFileSync(join(ws.root, '.devmate', 'state', 'task.json'), 'utf8');
    const state = JSON.parse(raw);
    assert.equal(validateTaskState(state).ok, true);
    assert.equal(state.workflowGate, 'plan-approved', 'the un-persisted advance must not appear on disk');
    assert.equal(state.currentStep, 7, 'the pre-write state is untouched');
  });

  it('writes no impl-started advance to the trace', () => {
    // recordGateTransition runs only after the state write succeeds, so a failed
    // commit must leave no gate_transition claiming the move happened.
    assert.equal(implStartedAdvances(ws.root, taskId).length, 0);
  });

  it('surfaces the write failure rather than swallowing it', () => {
    assert.notEqual(ran.status, 0, `a failed gate write must not report success:\n${ran.stdout}`);
    assert.match(ran.stderr, /EISDIR|lock failed|writeTaskState|handler failed/i);
  });
});

// ── Scenario 4: a domain-context write racing a gate advance (issue #175) ─────

/**
 * Rewrite the workspace config to declare a `billing` domain, so
 * recordDomainContext actually resolves a match and writes `activeDomains`
 * (with no domains it early-returns and the race never fires).
 * @param {string} root
 */
function configureBillingDomain(root) {
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [
        {
          persona: 'backend',
          editableGlobs: ['repo-a/lib/**', '.devmate/**'],
          offLimitsGlobs: [],
          testGlobs: ['repo-a/test/**'],
          instructionFile: null,
        },
      ],
      domains: [
        {
          domain: 'billing',
          keywords: ['billing', 'invoice'],
          globs: ['repo-a/lib/billing/**'],
          contextFile: null,
        },
      ],
    }),
    'utf8',
  );
}

describe('E2E concurrency — a domain-context write cannot clobber a concurrent gate advance (#175)', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {HookRun} */
  let approveRun;

  before(async () => {
    ws = boot();
    taskId = seedPlanApproved(ws.root, 'bug');
    configureBillingDomain(ws.root);
    // Racer A approves the plan (the gate advance). Racer B is a plain prompt whose
    // text matches the `billing` domain, so its recordDomainContext writes
    // activeDomains to the SAME task.json — the exact read-modify-write that, when
    // unlocked, could write back a stale gate and lose A's advance.
    [approveRun] = await Promise.all([
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('approve plan'), ws.hostCwd),
      spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('how does billing and invoice generation work?'), ws.hostCwd),
    ]);
    // Then one MORE billing prompt, sequentially, so the domain-write path is
    // exercised deterministically (not left to the race's timing): it must land
    // activeDomains AND leave the advanced gate intact.
    await spawnHookAsync('hooks/approval-listener.mjs', [], promptPayload('billing and invoice questions'), ws.hostCwd);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('the gate advance survives the concurrent domain write — task.json lands at impl-started, valid', () => {
    const raw = readFileSync(join(ws.root, '.devmate', 'state', 'task.json'), 'utf8');
    const state = JSON.parse(raw); // atomic rename guarantees a whole file
    assert.equal(validateTaskState(state).ok, true);
    // The whole point of #175: the domain write reads the fresh state under the
    // lock, so it can never revert the gate. The advance is preserved.
    assert.equal(state.workflowGate, 'impl-started', 'the domain write must not clobber the gate advance');
    assert.equal(state.currentStep, 0, 'transitionGate reset currentStep on the advance');
    assert.equal(approveRun.status, 0, `the approve-plan turn must report success:\n${approveRun.stderr}`);
  });

  it('the domain-write path lands activeDomains without reverting the advanced gate', () => {
    // The sequential billing prompt above ran mutateTaskStateUnderLock on the
    // fresh (impl-started) state: activeDomains is persisted AND the gate is
    // untouched — proving the read-inside-lock merge base is the advanced state.
    const state = readState(ws.root);
    assert.deepEqual(state.activeDomains, ['billing'], 'the domain resolution is persisted to task.json');
    assert.equal(state.workflowGate, 'impl-started', 'the domain write preserved the advanced gate');
  });

  it('records exactly one plan-approved -> impl-started advance — never lost, never doubled', () => {
    const advances = implStartedAdvances(ws.root, taskId);
    assert.equal(advances.length, 1, 'the single legal advance is recorded and not lost');
    assert.equal(advances[0].from, 'plan-approved');
    assert.equal(advances[0].to, 'impl-started');
    assert.equal(advances[0].evidence, 'approve plan');
  });
});
