// @ts-check
/**
 * #77 — the VS Code hook-contract conformance suite.
 *
 * Every other hook test in this repo imports a function and calls it with a
 * payload someone typed by hand. That is how five production defects (#72, #74,
 * #75, #76, and the output-shape family below) stayed green in CI for the life
 * of the plugin: the payloads encoded devmate's own wrong assumptions, so the
 * tests confirmed the bug instead of catching it.
 *
 * This suite does the one thing those cannot. For every command registered in
 * `hooks/hooks.json`, it **spawns the real entrypoint as a subprocess**, pipes a
 * real payload (see test/fixtures/hook-payloads/) to its stdin, and asserts the
 * four things the host actually cares about:
 *
 *   1. **It executes.** Not "it loads" — a registered no-op also loads, which is
 *      exactly what hooks/spec-integrity-guard.mjs was (#75).
 *   2. **It parses the payload without falling back to an invented key.** The
 *      fixtures carry no `repoRoot`, no `taskId`, no `workspaceRoot`, no
 *      `agentName` on a subagent event, and no `tool_input.path` — so a hook that
 *      still reads one gets `undefined` and its fallback fires, which shows up as
 *      a doubled `.devmate/.devmate/`, a sentinel-keyed trace file, or a rule
 *      that silently never fires (#76).
 *   3. **Its stdout conforms to that event's output schema.** A verdict in a
 *      shape the host does not read is not a verdict. This is what made the
 *      PreToolUse deny (#74), the PostToolUse block, and the SubagentStart gate
 *      inert — three enforcement layers, all "wired", none of them live.
 *   4. **It writes only under the resolved workspace root.**
 *
 * The suite is the reason the class cannot come back. If VS Code renames a tool
 * or moves a field, a fixture stops matching reality and these tests go red —
 * loudly, at the process boundary, where the plugin actually lives.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { loadHookManifest, extractScriptPath } from '../../lib/hooks/registry.mjs';
import { validateHookOutput } from '../../lib/hooks/output-schema.mjs';
import { getOwn } from '../../lib/object-utils.mjs';
import { markDevmateSession } from '../../lib/hooks/session-marker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'hook-payloads');

/**
 * @typedef {Object} Fixture
 * @property {string} file
 * @property {import('../../lib/types.mjs').HookEvent} event
 * @property {'captured'|'derived'} provenance
 * @property {string} source
 * @property {string} proves
 * @property {{ cwd?: string, toolInputFilePath?: string }} rebase
 */

/** @returns {{ fixtures: Fixture[] }} */
function loadManifest() {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
}

/**
 * Seed a workspace in the monoroot layout: a repo with a `.devmate/` folder that
 * VS Code lists as workspaceFolders[0] — and therefore hands the hook as its cwd.
 * @param {{ task?: boolean, gate?: string, persona?: string }} [opts]
 * @returns {{ root: string, devmateDir: string }}
 */
function seedWorkspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conformance-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'example.mjs'), 'const a = 1;\n', 'utf8');
  // A REAL config: `personas` is a non-empty array, and the persona owning the
  // paths these fixtures edit is the one task.json pins as active. A hook that
  // is handed an invalid config takes its config-missing branch, which would let
  // every assertion below pass for the wrong reason.
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [
        {
          persona: opts.persona ?? 'backend',
          editableGlobs: ['lib/**', '.devmate/**'],
          offLimitsGlobs: [],
          testGlobs: ['test/**'],
          instructionFile: null,
        },
      ],
    }),
    'utf8',
  );
  if (opts.task) {
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId: 'feat-77',
        lane: 'feature',
        workflowGate: opts.gate ?? 'impl-started',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 0,
        budget: 100,
        activePersona: opts.persona ?? 'backend',
        schemaVersion: 1,
      }),
      'utf8',
    );
  }
  return { root, devmateDir: join(root, '.devmate') };
}

/**
 * Rebase a fixture's environment-specific paths onto a temp workspace. Only the
 * fields the manifest names are touched, and each is rebuilt with path.join so
 * the suite runs on Windows and POSIX alike — the fixture file on disk is never
 * edited, so "captured" keeps meaning captured.
 * @param {Record<string, unknown>} payload
 * @param {Fixture} fx
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function rebase(payload, fx, root) {
  /** @type {Record<string, unknown>} */
  const next = { ...payload };
  if (fx.rebase.cwd !== undefined) {
    next['cwd'] = join(root, fx.rebase.cwd);
  }
  if (fx.rebase.toolInputFilePath !== undefined) {
    const ti = next['tool_input'];
    if (ti !== null && typeof ti === 'object') {
      next['tool_input'] = {
        .../** @type {Record<string, unknown>} */ (ti),
        filePath: join(root, fx.rebase.toolInputFilePath),
      };
    }
  }
  return next;
}

/**
 * Every file under `dir`, repo-relative, sorted. Used to prove a hook wrote
 * nothing outside the root it resolved.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  // @bounded-alloc — one entry per file a hook wrote into a fresh temp
  // workspace; a hook writes a handful of state files, never a tree.
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * Spawn one registered hook command exactly as the host does: `node <script>
 * [args]`, payload on stdin, **cwd = the workspace's own .devmate folder**.
 * @param {string} script  Repo-relative script path from hooks.json.
 * @param {string[]} args
 * @param {unknown} payload
 * @param {string} cwd
 */
function spawnHook(script, args, payload, cwd) {
  // Enforcement is session-scoped: mark the payload's session as devmate so the
  // guarded hooks run live (a real session gets this from the first devmate
  // SubagentStart).
  const sid = getOwn(/** @type {Record<string, unknown>} */ (payload ?? {}), 'session_id');
  if (typeof sid === 'string' && sid !== '') markDevmateSession(sid, 'router');
  const r = spawnSync('node', [join(REPO_ROOT, script), ...args], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Every command in hooks/hooks.json, both the POSIX and the Windows form —
 * because both are hand-edited and either can drift (#48 was a Windows-only
 * break).
 * @returns {{ event: import('../../lib/types.mjs').HookEvent, script: string, args: string[] }[]}
 */
function registeredCommands() {
  const manifest = loadHookManifest(REPO_ROOT);
  /** @type {{ event: any, script: string, args: string[] }[]} */
  // @bounded-alloc — one entry per (event, command) pair in the repo's own
  // hooks.json, a fixed manifest with ten registrations.
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [event, entries] of Object.entries(manifest.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const field of [entry.command, entry.windows]) {
        if (typeof field !== 'string') continue;
        const script = extractScriptPath(field);
        if (script === null) continue;
        // Trailing words after the script path are the command's own args
        // (the subagent guard is registered twice, as `start` and `stop`).
        const args = field
          .split(/\s+/)
          .slice(1)
          .filter((t) => !t.includes('.mjs') && t !== '');
        const key = `${event}::${script}::${args.join(' ')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ event: /** @type {any} */ (event), script, args });
      }
    }
  }
  return out;
}

// ── 1. Registration is complete and every fixture is real ────────────────────

describe('the fixtures and the manifest agree with hooks.json', () => {
  test('every registered event has at least one payload fixture', skipUnlessNode(24), () => {
    const events = new Set(registeredCommands().map((c) => c.event));
    const covered = new Set(loadManifest().fixtures.map((f) => f.event));
    for (const event of events) {
      assert.ok(covered.has(event), `no fixture for the registered event ${event}`);
    }
  });

  test('no fixture carries a key devmate invented', skipUnlessNode(24), () => {
    // The whole bug class started as a payload field that felt plausible. If one
    // of these ever appears in a fixture "to make a test pass", the fiction is
    // back and the suite is worthless.
    const banned = ['repoRoot', 'taskId', 'workspaceRoot', 'agentName', 'agentId'];
    for (const fx of loadManifest().fixtures) {
      // @bounded-alloc — one parse per fixture in the repo's own manifest, a
      // committed file with a fixed handful of entries.
      const payload = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      for (const key of banned) {
        assert.ok(
          !(key in payload),
          `${fx.file} carries the invented top-level key "${key}" — no VS Code event sends it`,
        );
      }
      const ti = payload.tool_input;
      if (ti !== undefined && ti !== null && typeof ti === 'object') {
        assert.ok(
          !('path' in ti),
          `${fx.file} carries tool_input.path — VS Code names the target filePath/dirPath, never path`,
        );
      }
      assert.ok(
        typeof payload.hook_event_name === 'string',
        `${fx.file} must carry hook_event_name`,
      );
    }
  });
});

// ── 2. Execute · parse · conform · write where you resolved ──────────────────

describe('every registered hook honors the VS Code contract on a real payload', () => {
  const fixtures = loadManifest().fixtures;

  for (const cmd of registeredCommands()) {
    const forEvent = fixtures.filter((f) => f.event === cmd.event);

    for (const fx of forEvent) {
      const label = `${cmd.event} ${cmd.script}${cmd.args.length ? ' ' + cmd.args.join(' ') : ''} ← ${fx.file}`;

      test(label, skipUnlessNode(24), () => {
        // An active task at impl-started is the state most rules key on; it is
        // also the state in which a wrongly-resolved root does the most damage.
        // @bounded-alloc — one temp workspace per (registered command × fixture)
        // pair, from the repo's own hooks.json and manifest; each is removed in
        // the `finally` below.
        const { root, devmateDir } = seedWorkspace({ task: true });
        try {
          // @bounded-alloc — one fixture read per test; the fixture set is a
          // committed directory, not input.
          const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
          const payload = rebase(raw, fx, root);
          const r = spawnHook(cmd.script, cmd.args, payload, devmateDir);

          // 1. It executed. A hook that crashed cannot enforce anything.
          assert.doesNotMatch(
            r.stderr,
            /MODULE_NOT_FOUND|SyntaxError|ReferenceError|TypeError|ERR_/,
            `${label} crashed:\n${r.stderr}`,
          );
          assert.ok(
            [0, 1, 2].includes(r.status),
            `${label} exited ${r.status}; VS Code documents 0 (parse stdout), 2 (block), other non-zero (warn)`,
          );

          // 2. It parsed the payload without falling back to an invented key.
          //    Each of these is the signature of one such fallback.
          assert.equal(
            existsSync(join(devmateDir, '.devmate')),
            false,
            `${label} created .devmate/.devmate — it anchored a path on the raw hook cwd`,
          );
          const traceDir = join(root, '.devmate', 'state', 'trace');
          const traces = existsSync(traceDir) ? readdirSync(traceDir) : [];
          assert.ok(
            !traces.includes('unknown.jsonl'),
            `${label} wrote a sentinel-keyed trace — it read an id no host sends`,
          );

          //    A hook that mis-resolves the root does not always get as far as
          //    *writing* the doubled path: it can also just fail to find what it
          //    was looking for and bail with a warning. That is how the
          //    SessionStart resolver stayed broken through the first draft of
          //    this very suite — the "no .devmate/.devmate on disk" assertion
          //    above passed precisely BECAUSE the hook errored out before
          //    creating anything. So assert on what it SAYS, too: no hook may
          //    ever name a doubled path on either stream.
          const doubled = /[\\/]\.devmate[\\/]\.devmate[\\/]/;
          assert.doesNotMatch(
            r.stdout + r.stderr,
            doubled,
            `${label} resolved a doubled .devmate path — the root came from the raw cwd`,
          );

          // 3. Its stdout conforms to this event's documented output schema.
          const check = validateHookOutput(cmd.event, r.stdout, r.status);
          assert.deepEqual(
            check.errors,
            [],
            `${label} emitted output the host would drop or misread:\n` +
              `  stdout: ${JSON.stringify(r.stdout)}\n  exit: ${r.status}`,
          );

          // 4. It wrote only under the root it resolved.
          for (const f of walk(root)) {
            assert.ok(
              f.startsWith('.devmate/') || f.startsWith('lib/') || f.startsWith('.git/'),
              `${label} wrote outside the workspace's .devmate: ${f}`,
            );
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

// ── 3. The gates actually gate — in a shape the host honors ──────────────────

describe('the enforcement layers produce a verdict VS Code will act on', () => {
  test('PreToolUse: an out-of-gate source edit is DENIED, not merely computed', skipUnlessNode(24), () => {
    // plan-approved is before impl-started: no implementation may be written.
    const { root, devmateDir } = seedWorkspace({ task: true, gate: 'plan-approved' });
    try {
      const fx = loadManifest().fixtures.find(
        (f) => f.file === 'derived/pretooluse.replace-string-in-file.json',
      );
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook('scripts/gate-guard.mjs', [], rebase(raw, fx, root), devmateDir);

      const check = validateHookOutput('PreToolUse', r.stdout, r.status);
      assert.deepEqual(check.errors, []);
      assert.equal(
        check.effect,
        'block',
        `the edit must be blocked, and in the honored shape. Got: ${r.stdout}`,
      );
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(String(parsed.hookSpecificOutput.permissionDecisionReason), /\S/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SubagentStart: HITL-1 blocks an implementation dispatch with no task', skipUnlessNode(24), () => {
    // SubagentStart documents NO permission field, so a guard that emits one is
    // emitting into the void. The documented stops are `continue: false` and
    // exit 2 — this asserts the host would really stop, whichever it honors.
    const { root, devmateDir } = seedWorkspace(); // no task.json at all
    try {
      const fx = loadManifest().fixtures.find(
        (f) => f.file === 'derived/subagentstart.fullstack.json',
      );
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook(
        'hooks/subagent-budget-guard.mjs',
        ['start'],
        rebase(raw, fx, root),
        devmateDir,
      );

      const check = validateHookOutput('SubagentStart', r.stdout, r.status);
      assert.deepEqual(check.errors, [], `stdout: ${r.stdout}`);
      assert.equal(
        check.effect,
        'block',
        `an implementation dispatch with no approved spec must be stopped. stdout=${JSON.stringify(r.stdout)} exit=${r.status}`,
      );
      // On a blocking exit the model reads stderr — the reason has to be there.
      assert.match(r.stderr, /init-task-state|not yet|spec/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SubagentStart: an analysis dispatch pre-task is allowed and traces nothing', skipUnlessNode(24), () => {
    const { root, devmateDir } = seedWorkspace();
    try {
      const fx = loadManifest().fixtures.find((f) => f.file === 'derived/subagentstart.json');
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook(
        'hooks/subagent-budget-guard.mjs',
        ['start'],
        rebase(raw, fx, root),
        devmateDir,
      );
      const check = validateHookOutput('SubagentStart', r.stdout, r.status);
      assert.deepEqual(check.errors, []);
      assert.notEqual(check.effect, 'block', 'discovery must still run before a task exists');
      assert.equal(existsSync(join(root, '.devmate', 'state', 'trace')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('PostToolUse: a malformed worker return BLOCKS the lane', skipUnlessNode(24), () => {
    // The validator located artifacts by tool_input.path — a key VS Code never
    // sends — so it found nothing, returned 0, and validated nothing in
    // production. And exit 1 (its old failure code) is a *non-blocking warning*
    // to the host: even when it did fire, the lane sailed on.
    const { root, devmateDir } = seedWorkspace({ task: true });
    try {
      const returns = join(root, '.devmate', 'state', 'worker-returns');
      mkdirSync(returns, { recursive: true });
      writeFileSync(join(returns, 'w1.json'), JSON.stringify({ taskId: 'feat-77' }), 'utf8');

      const fx = loadManifest().fixtures.find(
        (f) => f.file === 'derived/posttooluse.create-file.json',
      );
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook(
        'hooks/contract-validator.mjs',
        [],
        rebase(raw, fx, root),
        devmateDir,
      );

      const check = validateHookOutput('PostToolUse', r.stdout, r.status);
      assert.deepEqual(check.errors, [], `stdout: ${r.stdout}`);
      assert.equal(
        check.effect,
        'block',
        `an invalid worker return must halt the lane. stdout=${JSON.stringify(r.stdout)} exit=${r.status}`,
      );
      assert.match(r.stderr, /contract violation/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SessionStart: the bootstrap reaches the model as one JSON document', skipUnlessNode(24), () => {
    // Two ways this hook was mute, and the second nearly slipped through.
    //
    // 1. It printed human text, and on exit 0 the host parses stdout as JSON —
    //    so every line was dropped.
    // 2. It resolved its root with the ONE code path that still discarded the
    //    .devmate climb (repo-root.mjs step 5), so in the monoroot layout it
    //    looked for the config at `.devmate/.devmate/devmate.config.json`,
    //    didn't find it, and exited 1 telling the user to run `devmate init` —
    //    in an initialized workspace.
    //
    // The first draft of this test asserted the envelope only `if (status === 0)`,
    // which meant defect 2 made it PASS by never reaching the assertion. A
    // conformance test that lets the hook opt out of being checked by failing is
    // not a conformance test. The workspace below IS initialized, so the only
    // acceptable outcome is success.
    const { root, devmateDir } = seedWorkspace({ task: true });
    try {
      const fx = loadManifest().fixtures.find((f) => f.file === 'derived/sessionstart.json');
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook('scripts/session-start.mjs', [], rebase(raw, fx, root), devmateDir);

      assert.equal(
        r.status,
        0,
        `SessionStart must succeed in an initialized workspace. stderr:\n${r.stderr}`,
      );
      const check = validateHookOutput('SessionStart', r.stdout, r.status);
      assert.deepEqual(check.errors, [], `stdout: ${JSON.stringify(r.stdout)}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(String(parsed.hookSpecificOutput.additionalContext), /\S/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('UserPromptSubmit: the state anchor is emitted as JSON, not raw text', skipUnlessNode(24), () => {
    const { root, devmateDir } = seedWorkspace({ task: true });
    try {
      const fx = loadManifest().fixtures.find((f) => f.file === 'derived/userpromptsubmit.json');
      assert.ok(fx);
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fx.file), 'utf8'));
      const r = spawnHook('hooks/approval-listener.mjs', [], rebase(raw, fx, root), devmateDir);

      const check = validateHookOutput('UserPromptSubmit', r.stdout, r.status);
      assert.deepEqual(check.errors, [], `stdout: ${JSON.stringify(r.stdout)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
