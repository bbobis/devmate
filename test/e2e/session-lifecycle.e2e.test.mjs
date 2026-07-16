// @ts-check
/**
 * END-TO-END: replay a real session through the real hooks, then assert what is
 * actually on disk.
 *
 * ## Why this suite exists
 *
 * A user's feature-lane session silently collapsed: `@discovery` "completed with
 * no output", the orchestrator concluded devmate was broken and did the work
 * inline, `[BUDGET:unclassified]` fired on every tool call, and `trace/` and
 * `handoff/` stayed empty. **The entire test suite was green throughout.**
 *
 * It was green because every test asked the wrong question:
 *
 *   - Unit tests imported a function and passed it a payload someone typed by
 *     hand, so they asserted devmate's own wrong assumptions back to itself.
 *   - The agent tests asserted that an INSTRUCTION was present in a prompt
 *     (`assert.match(body, /orch-assert-floor\.mjs/)`) — an instruction the
 *     orchestrator has no tool to run. CI guaranteed the inert layer stayed.
 *   - Even the conformance suite, which does spawn the real hooks, spawns each
 *     one ALONE against a pre-seeded workspace. Every hook can pass in isolation
 *     while the session as a whole produces nothing, because the bug was in what
 *     NOBODY wrote: `task.json` had no writer, and `worker-returns/` had no
 *     writer, so four subsystems went quiet at once and no single hook was at
 *     fault.
 *
 * So this suite asks the only question that could have caught it: **run a whole
 * session and see whether the state the workflow depends on actually exists.**
 *
 * It replays the ORDERED event stream captured from the failing session
 * (test/fixtures/hook-payloads/sessions/) — SessionStart → UserPromptSubmit →
 * PreToolUse → PostToolUse → PreToolUse(runSubagent) → SubagentStart →
 * SubagentStop → PostToolUse(runSubagent) → Stop — spawning every hook that
 * `hooks/hooks.json` registers for each event, as a real subprocess, with the
 * payload on stdin and `cwd` set exactly as the host sets it (the workspace's own
 * `.devmate/` folder, which is what monoroot makes workspaceFolders[0]).
 *
 * Then it asserts the end state. **Every assertion below is a defect that
 * shipped.** Each one fails on the code as it was.
 *
 * ## The trap this suite is built to avoid
 *
 * Do not "fix" a failure here by seeding the state the assertion looks for. The
 * point is that the SESSION produces it. A workspace pre-seeded with a
 * `task.json` would make most of this pass against the broken code — which is
 * precisely how the old tests passed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadHookManifest, extractScriptPath } from '../../lib/hooks/registry.mjs';
import { readJsonlSync } from '../../lib/json-io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SESSION_FIXTURE = join(
  __dirname,
  '..',
  'fixtures',
  'hook-payloads',
  'sessions',
  'feature-lane-router.session.json',
);

/** The cwd the host actually hands every hook in the monoroot layout. */
const HOST_CWD_REL = '.devmate';

/**
 * Build the workspace in the user's real shape: a monoroot worktree whose
 * `.devmate/` sits at the ROOT, beside repo subfolders that each carry their own
 * `.git`. The root itself is not a git repo.
 *
 * This layout is load-bearing. A hook that resolves its root by walking up to the
 * nearest marker lands on `repo-a/.git` and reads/writes a phantom
 * `repo-a/.devmate/`, while SessionStart uses the workspace root — writes and
 * reads in different trees. A flat single-repo fixture cannot express that, which
 * is why it was never caught.
 *
 * Nothing under `.devmate/state/` is seeded. The session must create it.
 *
 * @returns {{ root: string, hostCwd: string }}
 */
function seedMonorootWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'e2e-session-'));

  mkdirSync(join(root, '.devmate'), { recursive: true });
  mkdirSync(join(root, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(root, 'repo-a', 'lib'), { recursive: true });
  mkdirSync(join(root, 'repo-b', '.git'), { recursive: true });

  // A real config: a hook handed an invalid one takes its config-missing branch,
  // which would let assertions pass for the wrong reason.
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
    }),
    'utf8',
  );

  return { root, hostCwd: join(root, HOST_CWD_REL) };
}

/**
 * Every hook command `hooks/hooks.json` registers for one event, in order.
 * Read from the real manifest — not a list typed here — so a hook that is
 * registered but broken cannot hide behind a test that forgot to run it.
 * @param {string} event
 * @returns {{ script: string, args: string[] }[]}
 */
function hooksFor(event) {
  const manifest = loadHookManifest(REPO_ROOT);
  const entries = manifest.hooks?.[event] ?? [];
  /** @type {{ script: string, args: string[] }[]} */
  // @bounded-alloc — one entry per registration for a single event (at most 4).
  const out = [];
  for (const entry of entries) {
    const command = entry.command;
    if (typeof command !== 'string') continue;
    const script = extractScriptPath(command);
    if (script === null) continue;
    const args = command
      .slice(command.indexOf(script) + script.length)
      .replace(/^["']/, '')
      .trim()
      .split(/\s+/)
      .filter((a) => a !== '');
    out.push({ script, args });
  }
  return out;
}

/**
 * Rebase a captured payload onto the temp workspace. Only `cwd` is touched —
 * the capture's own absolute paths are otherwise left alone, so "captured" keeps
 * meaning captured.
 * @param {Record<string, unknown>} event
 * @param {string} hostCwd
 * @returns {Record<string, unknown>}
 */
function rebase(event, hostCwd) {
  return { ...event, cwd: hostCwd };
}

/**
 * Spawn one hook exactly as the host does: `node <script> [args]`, payload on
 * stdin, cwd = the workspace's own `.devmate` folder.
 * @param {string} script
 * @param {string[]} args
 * @param {unknown} payload
 * @param {string} cwd
 */
function spawnHook(script, args, payload, cwd) {
  const r = spawnSync('node', [join(REPO_ROOT, script), ...args], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { script, status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Every file under `dir`, relative and slash-normalized.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  // @bounded-alloc — the state a session writes into a fresh temp workspace: a
  // handful of files, never a tree.
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(abs, base));
    else out.push(abs.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

describe('E2E — a real session, replayed through the real hooks', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let hostCwd;
  /** @type {ReturnType<typeof spawnHook>[]} */
  let ran = [];

  before(() => {
    const fixture = JSON.parse(readFileSync(SESSION_FIXTURE, 'utf8'));
    ({ root, hostCwd } = seedMonorootWorkspace());

    for (const event of fixture.events) {
      const payload = rebase(event, hostCwd);
      for (const { script, args } of hooksFor(event.hook_event_name)) {
        ran.push(spawnHook(script, args, payload, hostCwd));
      }
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Absolute path to the task state the whole runtime hangs off. */
  const statePath = () => join(root, '.devmate', 'state', 'task.json');

  it('every registered hook actually ran (a session that spawns nothing proves nothing)', () => {
    assert.ok(ran.length > 0, 'no hooks were spawned — the manifest read must have failed');
    // A hook that crashes on a real payload is the failure mode #75 shipped as.
    // Exit 2 is a legitimate *blocking* verdict; a crash is not. Node reports an
    // uncaught throw as exit 1 with a stack on stderr.
    for (const r of ran) {
      assert.ok(
        !/^\s*(node:internal|Error:|TypeError:|ReferenceError:)/m.test(r.stderr),
        `${r.script} threw on a real payload:\n${r.stderr}`,
      );
    }
  });

  it('the session CREATES task.json — nothing used to, so four subsystems went quiet at once', () => {
    // The keystone defect. init-task-state was invoked only from a line in the
    // orchestrator prompt, and the orchestrator has no `execute` tool — so
    // task.json was never written, and with it went the trace, the handoff, the
    // memory ledger and the budget class.
    assert.ok(
      existsSync(statePath()),
      `task.json was never created. Files written:\n${walk(root).join('\n')}`,
    );
  });

  it('task.json lands at the WORKSPACE root — not doubled, not inside a sibling repo', () => {
    // Two failures at once, both shipped:
    //   .devmate/.devmate/state/task.json  — a cwd-relative write, with cwd
    //                                        already being the .devmate folder (#76)
    //   repo-a/.devmate/state/task.json    — a root walk that stopped at the
    //                                        nearest .git in the monoroot layout
    assert.ok(!existsSync(join(root, '.devmate', '.devmate')), 'doubled .devmate/.devmate/ was created');
    assert.ok(!existsSync(join(root, 'repo-a', '.devmate')), 'state leaked into repo-a/.devmate/');
    assert.ok(!existsSync(join(root, 'repo-b', '.devmate')), 'state leaked into repo-b/.devmate/');
  });

  it('the bootstrapped task never starts at plan-approved, and ADVANCES on the router return', () => {
    // Two invariants, and they pull against each other — which is the whole
    // point of asserting them together.
    //
    // 1. Bootstrapping must not open a gate. `init-task-state` writes
    //    `plan-approved`; seeding THAT on every session start would hand
    //    @fullstack an open implementation gate on a task no human has seen.
    //
    // 2. But the gate must still MOVE. This assertion used to read
    //    `assert.equal(state.workflowGate, 'no-lane')` — and it passed, on a
    //    replay that dispatches @router and gets a clean lane back, because
    //    NOTHING in the product could advance a gate (#91). A green test pinned
    //    the frozen gate in place: the session sat at `no-lane` for its whole
    //    life, the human spec gate was never reached, and gate-guard — which
    //    only denied at `plan-approved` — waved every source edit through.
    //
    // The router return is real evidence on disk, so the gate is now past
    // `no-lane`. It has NOT run away to an implementation gate: the lane still
    // needs its discovery, grill, plan, spec, and a human.
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    assert.notEqual(state.workflowGate, 'plan-approved');
    assert.notEqual(
      state.workflowGate,
      'no-lane',
      'the gate never advanced: the router returned a lane and nothing recorded it',
    );
    assert.equal(state.workflowGate, 'lane-set');
    assert.equal(state.lane, 'feature', 'the lane the router classified was not persisted');
    assert.ok(typeof state.taskId === 'string' && state.taskId.length > 0);

    // The evidence itself: the artifact the `lane-set` precondition reads, which
    // no agent could ever have written (they are all read-only).
    const routerResult = JSON.parse(
      readFileSync(join(root, '.devmate', 'state', 'router-result.json'), 'utf8'),
    );
    assert.equal(routerResult.lane, 'feature');
  });

  it('source edits are DENIED at no-lane — the gate-guard fail-open that let the spec gate be skipped', () => {
    // The security half of #91. With the gate frozen at `no-lane`, evaluateGuard
    // compared against the one hard-coded string `plan-approved`, missed, and
    // fell through to `return { decision: 'allow' }` — so an agent could write
    // product source before any spec existed, let alone was approved. The
    // fail-closed allowlist that forbids exactly this (lib/gate-edit-policy.mjs)
    // had eight green unit tests and no production caller.
    const dir = mkdtempSync(join(tmpdir(), 'devmate-gate-open-'));
    try {
      mkdirSync(join(dir, '.devmate', 'state'), { recursive: true });
      writeFileSync(
        join(dir, '.devmate', 'devmate.config.json'),
        JSON.stringify({
          schemaVersion: 1,
          personas: [{ persona: 'backend', editableGlobs: ['src/**'], offLimitsGlobs: [] }],
        }),
      );
      writeFileSync(
        join(dir, '.devmate', 'state', 'task.json'),
        JSON.stringify({
          taskId: 'T-1',
          lane: 'feature',
          workflowGate: 'no-lane',
          currentStep: 0,
          artifactHashes: {},
          preImplStash: null,
          budget: 10,
          activePersona: 'backend',
          tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
          schemaVersion: 1,
        }),
      );

      const res = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'gate-guard.mjs')],
        {
          input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'create_file',
            tool_input: { filePath: join(dir, 'src', 'app.js'), content: 'x' },
            cwd: join(dir, '.devmate'),
          }),
          encoding: 'utf8',
        },
      );

      const out = JSON.parse(res.stdout);
      assert.equal(
        out.hookSpecificOutput.permissionDecision,
        'deny',
        'source edit at no-lane was ALLOWED — the spec gate is unenforced',
      );
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /impl-started/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the budget guard stops reporting [BUDGET:unclassified] on every single tool call', () => {
    // What the user saw on every tool call. Two causes, both fixed: no task.json
    // existed at all, AND check-session-budget resolved the path against cwd
    // (which is the .devmate folder), so it looked in .devmate/.devmate/.
    const budgetRuns = ran.filter((r) => r.script.includes('check-session-budget'));
    assert.ok(budgetRuns.length > 0, 'the budget hook never ran');

    const unclassified = budgetRuns.filter((r) =>
      (r.stdout + r.stderr).includes('[BUDGET:unclassified]'),
    );
    assert.equal(
      unclassified.length,
      0,
      `budget reported unclassified ${unclassified.length}/${budgetRuns.length} times despite a persisted OutputContract`,
    );

    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    assert.ok(state.outputContract, 'no OutputContract was persisted');
    assert.equal(typeof state.outputContract.token_budget_class, 'string');
  });

  it("the subagent's return is PERSISTED — the artifact the dispatch protocol was built on", () => {
    // `orch-assert-dispatch --file <path>` validated it and `merge-discovery`
    // read the directory, but NOTHING could write it: every analysis agent is
    // read-only and the orchestrator has no edit or execute tool. So a wave of
    // workers that returned good results looked like it had returned nothing —
    // which is what made the orchestrator give up and work inline.
    const dir = join(root, '.devmate', 'state', 'worker-returns');
    assert.ok(existsSync(dir), 'worker-returns/ was never created');

    const files = readdirSync(dir);
    assert.equal(files.length, 1, `expected exactly one persisted return, got: ${files.join(', ')}`);

    const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    // Parsed out of a response that is prose FOLLOWED BY JSON — a plain
    // JSON.parse of it throws, which is why the old parser returned null on every
    // real dispatch.
    assert.equal(written.agentName, 'router');
    assert.equal(written.lane, 'feature');
    assert.equal(written.budgetClass, 'standard');
  });

  it('the return file is keyed per dispatch, so a parallel fan-out cannot overwrite itself', () => {
    // The orchestrator dispatches @discovery K times in ONE wave. A name-keyed
    // file would leave a single survivor and make a fan-out look like it mostly
    // vanished — the same symptom, from a different cause.
    const [file] = readdirSync(join(root, '.devmate', 'state', 'worker-returns'));
    assert.match(file, /^router\..+\.json$/, `expected <agent>.<toolUseId>.json, got ${file}`);
    assert.ok(file.includes('toolu_bdrk_01UqQ3JGUVF9NsqCmRoSWWkW'), 'the dispatch id is not in the filename');
  });

  it('the trace is written, under the real taskId — not empty, and not under a sentinel', () => {
    // The user reported an empty trace/ dir. It was empty because the trace
    // writer keys every event on state.taskId, and there was no state. An earlier
    // defect (#76) minted the literal "unknown", producing an unknown.jsonl that
    // no reader ever consults — absent state and fabricated state are both
    // failures.
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    const traceDir = join(root, '.devmate', 'state', 'trace');
    const tracePath = join(traceDir, `${state.taskId}.jsonl`);

    assert.ok(
      existsSync(tracePath),
      `no trace for taskId ${state.taskId}. trace/ contains: ${walk(traceDir).join(', ') || '(empty)'}`,
    );
    assert.ok(!existsSync(join(traceDir, 'unknown.jsonl')), 'trace was filed under the "unknown" sentinel');

    const events = /** @type {Record<string, unknown>[]} */ (readJsonlSync(tracePath));
    assert.ok(events.length > 0, 'the trace file exists but is empty');

    // The dispatch floor is enforced against these: they are the proof a
    // specialist actually ran, and the reason a gate may advance.
    const types = new Set(events.map((e) => e.type));
    assert.ok(types.has('subagent_start'), `no subagent_start event; got: ${[...types].join(', ')}`);
    assert.ok(types.has('subagent_complete'), `no subagent_complete event; got: ${[...types].join(', ')}`);
    assert.ok(
      events.every((e) => e.taskId === state.taskId),
      'a trace event was filed under a different taskId than the task itself',
    );
  });

  it('Stop writes a handoff instead of silently skipping with no_task', () => {
    // capture-handoff returns `skipped: 'no_task'` when task.json is missing, so
    // the empty handoff/ dir the user reported was this, every time.
    const stopRuns = ran.filter((r) => r.script.includes('session-stop'));
    assert.ok(stopRuns.length > 0, 'the Stop hook never ran');

    const output = stopRuns.map((r) => r.stdout + r.stderr).join('\n');
    assert.ok(!output.includes('no_task'), `Stop skipped the handoff with no_task:\n${output}`);

    const handoffDir = join(root, '.devmate', 'state', 'handoff');
    assert.ok(
      walk(handoffDir).length > 0,
      `handoff/ is empty after a full session. Files written:\n${walk(root).join('\n')}`,
    );
  });

  it('the session writes nothing outside the workspace root', () => {
    // Not hypothetical: the no-marker fallback scaffolded a real .devmate/ into
    // the user's HOME directory, with state/, memory/ and MEMORY.md in it.
    const written = walk(root);
    assert.ok(written.length > 0, 'the session wrote nothing at all');
    for (const f of written) {
      assert.ok(
        !f.includes('.devmate/.devmate'),
        `wrote to a doubled path: ${f}`,
      );
    }
  });
});

describe('E2E — an empty subagent return is surfaced, never swallowed', () => {
  /** @type {string} */
  let root;
  /** @type {ReturnType<typeof spawnHook>[]} */
  let ran = [];

  before(() => {
    const fixture = JSON.parse(readFileSync(SESSION_FIXTURE, 'utf8'));
    const seeded = seedMonorootWorkspace();
    root = seeded.root;

    // The SAME session, except the subagent comes back with nothing — literally
    // what VS Code renders as "Agent completed with no output", and the exact
    // trigger for the catastrophic behaviour: the orchestrator saw silence,
    // decided the agent was broken, and did the work itself.
    const events = fixture.events.map((/** @type {Record<string, unknown>} */ e) =>
      e.hook_event_name === 'PostToolUse' && e.tool_name === 'runSubagent'
        ? { ...e, tool_response: '' }
        : e,
    );

    for (const event of events) {
      const payload = rebase(event, seeded.hostCwd);
      for (const { script, args } of hooksFor(String(event.hook_event_name))) {
        ran.push(spawnHook(script, args, payload, seeded.hostCwd));
      }
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reports subagent.empty_result — the silence that the orchestrator routed around', () => {
    const output = ran.map((r) => r.stdout + r.stderr).join('\n');
    assert.ok(
      output.includes('subagent.empty_result'),
      `an empty subagent return produced no signal at all:\n${output}`,
    );
  });

  it('persists no worker return for an empty result, so no gate can advance on it', () => {
    const dir = join(root, '.devmate', 'state', 'worker-returns');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    assert.equal(files.length, 0, `an empty return was persisted as if it were a result: ${files.join(', ')}`);
  });

  it('still bootstraps the task, so the session stays governed even when a dispatch fails', () => {
    // The failure must not cascade: a bad dispatch is a halt, not a collapse of
    // the whole runtime into an ungoverned session.
    assert.ok(existsSync(join(root, '.devmate', 'state', 'task.json')));
  });
});

describe('E2E — a return with no tool_use_id is an error, never a sentinel filename', () => {
  /** @type {string} */
  let root;
  /** @type {ReturnType<typeof spawnHook>[]} */
  let ran = [];

  before(() => {
    const fixture = JSON.parse(readFileSync(SESSION_FIXTURE, 'utf8'));
    const seeded = seedMonorootWorkspace();
    root = seeded.root;

    // The return file is keyed by tool_use_id so a parallel wave of K same-named
    // workers cannot overwrite itself. Keying an id-less dispatch to a sentinel
    // ("unknown-dispatch") would defeat exactly that: every id-less return would
    // collide on one filename, a fan-out would look like it produced a single
    // result, and the dispatch floor would read that as evidence a specialist
    // ran. It is the shape of #76 — the `unknown.jsonl` no reader ever consults.
    const events = fixture.events.map((/** @type {Record<string, unknown>} */ e) => {
      if (e.hook_event_name !== 'PostToolUse' || e.tool_name !== 'runSubagent') return e;
      const { tool_use_id: _dropped, ...withoutId } = e;
      return withoutId;
    });

    for (const event of events) {
      const payload = rebase(event, seeded.hostCwd);
      for (const { script, args } of hooksFor(String(event.hook_event_name))) {
        ran.push(spawnHook(script, args, payload, seeded.hostCwd));
      }
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('persists nothing rather than writing a colliding sentinel filename', () => {
    const dir = join(root, '.devmate', 'state', 'worker-returns');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    // Empty, specifically. Not "one file named unknown-dispatch.json" — that is
    // the sentinel this asserts can never appear.
    assert.deepEqual(files, [], `an unattributable return was persisted: ${files.join(', ')}`);
  });

  it('says so out loud — an unattributable result must not pass silently', () => {
    const output = ran.map((r) => r.stdout + r.stderr).join('\n');
    assert.ok(
      output.includes('subagent.unattributable_result'),
      `no signal for a return that could not be keyed to its dispatch:\n${output}`,
    );
  });
});
