// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
  assertTestFileTouched,
  extractChangedFilesFromToolResponse,
  runWithIO,
} from "../../hooks/post-tool-use.mjs";
import { taskLedgerPath } from '../../lib/memory/paths.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';
import { traceFilePath } from "../../lib/trace/append.mjs";

/**
 * Build a readable stream wrapping a string for `process.stdin`-style use.
 * @param {string} s
 * @returns {import('node:stream').Readable}
 */
function stringReadable(s) {
  return Readable.from([Buffer.from(s, "utf8")]);
}

/**
 * Build a writable stream that collects all chunks into a string.
 * @returns {{ stream: import('node:stream').Writable, get: () => string }}
 */
function collectingWritable() {
  /** @type {Buffer[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  return { stream, get: () => Buffer.concat(chunks).toString("utf8") };
}

/**
 * Make a temp workspace + return paths. The hook uses `cwd` from the payload
 * to anchor the ledger path, so callers should pass `cwd: root`.
 * @returns {{ root: string, ledger: string, cleanup: () => void }}
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "post-tool-use-test-"));
  // Pre-create state + a valid active task so the hook can resolve task ledger.
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    resolve(root, '.devmate/state/task.json'),
    JSON.stringify({
      taskId: 'task-1',
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  const ledger = taskLedgerPath(root, 'task-1');
  return {
    root,
    ledger,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("runWithIO — edit-tool payload writes a fact line and exits 0", async () => {
  const { root, ledger, cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "lib/example.mjs" },
      cwd: root,
      hook_event_name: "PostToolUse",
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.get().trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.fact.source, "lib/example.mjs");
    assert.ok(existsSync(ledger));
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "fact");
  } finally {
    cleanup();
  }
});

test("runWithIO — non-edit tool payload exits 0 and writes no fact", async () => {
  const { root, ledger, cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: "read_file",
      tool_input: { filePath: "README.md" },
      cwd: root,
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.get().trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.fact, null);
    assert.equal(existsSync(ledger), false);
  } finally {
    cleanup();
  }
});

test("runWithIO — malformed stdin returns exit code 1 with actionable stderr", async () => {
  const { cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const stdin = stringReadable("{ not valid json !!");
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 1);
    assert.match(stderr.get(), /malformed stdin JSON/);
  } finally {
    cleanup();
  }
});

test("runWithIO — empty stdin exits 0 without crashing", async () => {
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  const stdin = stringReadable("");
  const code = await runWithIO(stdin, stdout.stream, stderr.stream);
  assert.equal(code, 0);
});

test('runWithIO — missing task.json is the quiet pre-task window: exit 0, single memory.skip, no writes (HITL-3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'post-tool-use-no-task-'));
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'lib/example.mjs' },
      cwd: root,
      hook_event_name: 'PostToolUse',
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);
    const lines = stderr.get().trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one stderr line');
    assert.match(lines[0], /memory\.skip/);
    assert.match(lines[0], /pre_task/);
    assert.equal(stdout.get().trim(), '');
    // Memory collection is skipped entirely: no fact ledger, no audit trace.
    assert.equal(existsSync(resolve(root, '.devmate', 'memory')), false);
    assert.equal(existsSync(resolve(root, '.devmate', 'state', 'trace')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Run the hook against a workspace whose task.json holds the given contents,
 * asserting the loud corrupted-state contract (exit 1, memory.error with
 * reason state_unreadable, empty stdout).
 * @param {string} contents  Raw task.json file contents.
 * @param {string} label     Assertion label for failure messages.
 * @returns {Promise<void>}
 */
async function assertCorruptedTaskStaysLoud(contents, label) {
  const root = mkdtempSync(join(tmpdir(), 'post-tool-use-bad-task-'));
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(resolve(root, '.devmate', 'state', 'task.json'), contents, 'utf8');
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'lib/example.mjs' },
      cwd: root,
      hook_event_name: 'PostToolUse',
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 1, `${label}: corrupted state must exit 1`);
    assert.match(stderr.get(), /memory\.error/, label);
    assert.match(stderr.get(), /state_unreadable/, label);
    assert.equal(stdout.get().trim(), '', label);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('runWithIO — invalid taskId in a well-formed task.json stays loud: exit 1, memory.error invalid_task_id (unchanged by HITL-3)', async () => {
  // Uppercase passes the TaskState schema (any non-empty string) but fails
  // TASK_ID_RE in validateTaskId — exercising the branch AFTER the state read.
  const root = mkdtempSync(join(tmpdir(), 'post-tool-use-bad-id-'));
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    resolve(root, '.devmate/state/task.json'),
    JSON.stringify({
      taskId: 'TASK-UPPERCASE',
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'lib/example.mjs' },
      cwd: root,
      hook_event_name: 'PostToolUse',
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 1);
    assert.match(stderr.get(), /memory\.error/);
    assert.match(stderr.get(), /invalid_task_id/);
    assert.equal(stdout.get().trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runWithIO — malformed task.json stays loud: exit 1, memory.error state_unreadable (HITL-3)', async () => {
  await assertCorruptedTaskStaysLoud('{ not json !!', 'malformed JSON');
});

test('runWithIO — schema-invalid task.json stays loud: exit 1, memory.error state_unreadable (HITL-3)', async () => {
  await assertCorruptedTaskStaysLoud(JSON.stringify({ taskId: 42, lane: 'nope' }), 'schema-invalid');
});

test("runWithIO — edit payload also appends an action trace line and exits 0", async () => {
  const { root, cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "lib/example.mjs" },
      cwd: root,
      hook_event_name: "PostToolUse",
      session_id: "sess-abc",
      timestamp: "2026-06-24T12:00:00.000Z",
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);

    // #76: actions are keyed on the ACTIVE TASK's id (from task.json) — the
    // same file every other event type uses. Keying on session_id scattered
    // them into a session-uuid file that `view-trace --task` never reads.
    const tracePath = traceFilePath("task-1", root);
    assert.ok(existsSync(tracePath));
    // The task file now interleaves ALL event types (that is the point — the
    // action used to be exiled to a session-uuid file). Assert on the action
    // event specifically, not on the file having exactly one line.
    const events = /** @type {Array<Record<string, unknown>>} */ (
      parseJsonl(readFileSync(tracePath, "utf8"))
    );
    const actions = events.filter((e) => e["type"] === "action");
    assert.equal(actions.length, 1);
    const ev = actions[0];
    assert.equal(ev["taskId"], "task-1");
    assert.equal(ev["actionType"], "replace_string_in_file");
    assert.equal(ev["path"], "lib/example.mjs");
    assert.match(String(ev["digest"]), /^[0-9a-f]{16}$/);
  } finally {
    cleanup();
  }
});

test("runWithIO — missing tool fields still audit (as unknown) into the TASK's trace", async () => {
  const { root, cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    // Keep task context via cwd, but omit tool/session fields to exercise
    // unknown-field audit fallback deterministically. actionType/path may
    // degrade to 'unknown' (informational fields) — but the FILE the event
    // lands in is keyed by the real taskId from task.json, never a sentinel:
    // the trace schema now rejects taskId 'unknown' outright (#76).
    const stdin = stringReadable(JSON.stringify({ cwd: root }));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);
    assert.equal(
      existsSync(traceFilePath("unknown", root)),
      false,
      "no sentinel-keyed trace file may ever be created",
    );
    const tracePath = traceFilePath("task-1", root);
    assert.ok(existsSync(tracePath));
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.equal(ev.type, "action");
    assert.equal(ev.actionType, "unknown");
    assert.equal(ev.path, "unknown");
    assert.equal(ev.taskId, "task-1");
  } finally {
    cleanup();
  }
});

test("runWithIO — audit failure never blocks: trace dir collision still exits 0", async () => {
  // Ledger dir is valid, but `.devmate/state/trace` is pre-created as a FILE,
  // so the trace mkdir throws. The hook must swallow that error, warn to
  // stderr, still write the fact, and exit 0.
  const { root, ledger, cleanup } = makeWorkspace();
  // Block the trace dir with a file at .devmate/state/trace.
  writeFileSync(resolve(root, ".devmate/state/trace"), "blocker");
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "a.mjs" },
      cwd: root,
      session_id: "sess-x",
    };
    const stdin = stringReadable(JSON.stringify(payload));
    const code = await runWithIO(stdin, stdout.stream, stderr.stream);
    assert.equal(code, 0);
    assert.match(stderr.get(), /action audit error \(ignored\)/);
    // Fact-write still happened despite the audit failure.
    assert.ok(existsSync(ledger));
  } finally {
    cleanup();
  }
});

test("hooks/hooks.json registers PostToolUse pointing to hooks/post-tool-use.mjs", () => {
  const manifestPath = resolve(
    import.meta.dirname ?? ".",
    "..",
    "..",
    "hooks/hooks.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = manifest.hooks.PostToolUse;
  assert.ok(Array.isArray(entries) && entries.length >= 1);
  assert.equal(entries[0].type, "command");
  // Plugin-installed hooks cannot use relative paths, so the command runs
  // through `node` and references the script via the ${PLUGIN_ROOT}
  // plugin-root token (Claude plugin format).
  assert.equal(
    entries[0].command,
    'node "${PLUGIN_ROOT}/hooks/post-tool-use.mjs"',
  );
});

test('post-tool-use › tripwire returns ok:false when no test-glob file touched', () => {
  const config = {
    schemaVersion: 1,
    personas: [
      { persona: 'frontend', editableGlobs: ['src/**'], testGlobs: ['**/*.spec.ts'] },
    ],
    verification: { unitTest: 'unit-tests' },
  };
  const result = assertTestFileTouched(
    { filesChanged: ['src/components/Button.tsx'] },
    config,
    'frontend',
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'tdd_skipped');
  }
});

test('post-tool-use › tripwire returns ok:true when at least one test-glob file touched', () => {
  const config = {
    schemaVersion: 1,
    personas: [
      { persona: 'frontend', editableGlobs: ['src/**'], testGlobs: ['**/*.spec.ts'] },
    ],
    verification: { unitTest: 'unit-tests' },
  };
  const result = assertTestFileTouched(
    { filesChanged: ['src/components/Button.spec.ts', 'src/components/Button.tsx'] },
    config,
    'frontend',
  );
  assert.equal(result.ok, true);
});

test('post-tool-use › tripwire returns ok:true when testGlobs not configured (graceful fallback)', () => {
  const config = {
    schemaVersion: 1,
    personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
    verification: { unitTest: 'unit-tests' },
  };
  const result = assertTestFileTouched(
    { filesChanged: ['src/components/Button.tsx'] },
    config,
    'frontend',
  );
  assert.equal(result.ok, true);
});

test('post-tool-use › tripwire only fires for configured persona test globs', () => {
  const config = {
    schemaVersion: 1,
    personas: [
      { persona: 'frontend', editableGlobs: ['src/**'], testGlobs: ['**/*.spec.ts'] },
      { persona: 'backend', editableGlobs: ['src/main/**'] },
    ],
    verification: { unitTest: 'unit-tests' },
  };

  const frontendResult = assertTestFileTouched(
    { filesChanged: ['src/components/Button.tsx'] },
    config,
    'frontend',
  );
  const backendResult = assertTestFileTouched(
    { filesChanged: ['src/main/service/UserService.java'] },
    config,
    'backend',
  );

  assert.equal(frontendResult.ok, false);
  assert.equal(backendResult.ok, true);
});

/**
 * Write a devmate.config.json (backend/frontend) with a personaScope mode.
 * @param {string} root
 * @param {string} mode
 */
function writePersonaConfig(root, mode) {
  writeFileSync(
    resolve(root, '.devmate/devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personaScope: mode,
      personas: [
        { persona: 'backend', editableGlobs: ['lib/**', 'src/**'], offLimitsGlobs: ['src/ui/**'] },
        { persona: 'frontend', editableGlobs: ['src/ui/**'] },
      ],
    }),
    'utf8',
  );
}

/**
 * A runSubagent PostToolUse payload for a fullstack dispatch.
 * @param {string} root
 * @param {string} persona
 * @param {string[]} changedFiles
 */
function fullstackDispatchPayload(root, persona, changedFiles) {
  return {
    tool_name: 'runSubagent',
    tool_input: { agentName: 'fullstack', persona },
    tool_response: { payload: { changedFiles } },
    cwd: root,
    hook_event_name: 'PostToolUse',
  };
}

test('extractChangedFilesFromToolResponse — object / json-string / content-wrapped / missing', () => {
  const obj = { payload: { changedFiles: ['a.mjs', 1, 'b.mjs'] } };
  assert.deepEqual(extractChangedFilesFromToolResponse(obj), ['a.mjs', 'b.mjs']);
  assert.deepEqual(extractChangedFilesFromToolResponse(JSON.stringify(obj)), ['a.mjs', 'b.mjs']);
  assert.deepEqual(extractChangedFilesFromToolResponse({ content: JSON.stringify(obj) }), ['a.mjs', 'b.mjs']);
  assert.equal(extractChangedFilesFromToolResponse({ payload: {} }), null);
  assert.equal(extractChangedFilesFromToolResponse('not json'), null);
  assert.equal(extractChangedFilesFromToolResponse(42), null);
});

test('runWithIO — persona-scope: out-of-territory dispatch flags a violation + trace', async () => {
  const { root, cleanup } = makeWorkspace();
  writePersonaConfig(root, 'block');
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = fullstackDispatchPayload(root, 'backend', ['lib/a.mjs', 'src/ui/button.mjs']);
    const code = await runWithIO(stringReadable(JSON.stringify(payload)), stdout.stream, stderr.stream);
    assert.equal(code, 0);
    const lines = stdout.get().trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]);
    assert.equal(out.reason, 'persona_scope_violation');
    assert.deepEqual(out.violations, ['src/ui/button.mjs']);

    const tracePath = traceFilePath('task-1', root);
    const events = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const cv = events.find((e) => e.type === 'contract_violation' && e.contract === 'persona-scope');
    assert.ok(cv, 'a persona-scope contract_violation should be emitted');
    assert.equal(cv.path, 'src/ui/button.mjs');
  } finally {
    cleanup();
  }
});

test('runWithIO — persona-scope: in-territory dispatch does not flag', async () => {
  const { root, cleanup } = makeWorkspace();
  writePersonaConfig(root, 'block');
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = fullstackDispatchPayload(root, 'backend', ['lib/a.mjs', 'src/b.mjs']);
    const code = await runWithIO(stringReadable(JSON.stringify(payload)), stdout.stream, stderr.stream);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout.get(), /persona_scope_violation/);
  } finally {
    cleanup();
  }
});

test('runWithIO — persona-scope: off mode skips the check', async () => {
  const { root, cleanup } = makeWorkspace();
  writePersonaConfig(root, 'off');
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = fullstackDispatchPayload(root, 'backend', ['src/ui/button.mjs']);
    const code = await runWithIO(stringReadable(JSON.stringify(payload)), stdout.stream, stderr.stream);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout.get(), /persona_scope_violation/);
  } finally {
    cleanup();
  }
});

test('runWithIO — persona-scope: parallel-safe via tool_response, not the shared ledger', async () => {
  // Two dispatches, each reporting only its own persona's files. Judged solely
  // by their own tool_response, both pass — even though a shared task-wide
  // ledger would interleave both personas' files.
  const { root, cleanup } = makeWorkspace();
  writePersonaConfig(root, 'block');
  try {
    /** @type {Array<[string, string[]]>} */
    const dispatches = [['backend', ['lib/a.mjs']], ['frontend', ['src/ui/b.mjs']]];
    for (const [persona, files] of dispatches) {
      const stdout = collectingWritable();
      const stderr = collectingWritable();
      const payload = fullstackDispatchPayload(root, persona, files);
      const code = await runWithIO(stringReadable(JSON.stringify(payload)), stdout.stream, stderr.stream);
      assert.equal(code, 0);
      assert.doesNotMatch(stdout.get(), /persona_scope_violation/, `${persona} should pass`);
    }
  } finally {
    cleanup();
  }
});

test('runWithIO — edit-tool payload emits a fact_write trace event for the task', async () => {
  const { root, cleanup } = makeWorkspace();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = {
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'lib/auth.mjs' },
      cwd: root,
      hook_event_name: 'PostToolUse',
    };
    const code = await runWithIO(stringReadable(JSON.stringify(payload)), stdout.stream, stderr.stream);
    assert.equal(code, 0);

    const tracePath = traceFilePath('task-1', root);
    assert.ok(existsSync(tracePath), 'a per-task trace file should exist');
    const events = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const factWrite = events.find((e) => e.type === 'fact_write');
    assert.ok(factWrite, 'a fact_write trace event should be emitted');
    assert.equal(factWrite.taskId, 'task-1');
    assert.equal(factWrite.sourcePointer, 'lib/auth.mjs');
    assert.equal(typeof factWrite.factKey, 'string');
    assert.ok(factWrite.factKey.length > 0);
  } finally {
    cleanup();
  }
});
