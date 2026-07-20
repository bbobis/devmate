// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runWithIO, emitMemoryContext } from '../../scripts/session-start.mjs';
import { STATE_DIRS as _STATE_DIRS } from '../../lib/init/layout.mjs';
import { MEMORY_PATH as _MEMORY_PATH, repoLedgerPath } from '../../lib/memory/paths.mjs';

/**
 * Build a readable stream wrapping a string for stdin-style use.
 * @param {string} s
 * @returns {import('node:stream').Readable}
 */
function stringReadable(s) {
  return Readable.from([Buffer.from(s, 'utf8')]);
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
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  return { stream, get: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * Make a temp repo root (with a .git marker so resolveRepoRoot lands here).
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'session-start-test-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Seed a fully-valid devmate CONSUMER repo into `root`:
 *   - .devmate/devmate.config.json with a minimal valid config
 *
 * Deliberately seeds NO `hooks/` or `scripts/`. Those are plugin-shipped and
 * are resolved against the plugin root, so a consumer repo never has them —
 * fabricating them here is what hid #72 (readiness looked for the plugin's
 * hooks.json inside the user's repo, so every real session failed the check).
 *
 * After calling this, assertDevmateReady(root) returns { ok: true }.
 * @param {string} root
 */
function seedValidEnvironment(root) {
  const devmateDir = join(root, '.devmate');
  mkdirSync(devmateDir, { recursive: true });
  writeFileSync(
    join(devmateDir, 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'fullstack', editableGlobs: ['src/**'] }],
      verification: { unitTest: 'node --test' },
    }),
  );
}

// ---- Fresh-repo (first-time init) happy paths ----

test('session-start — first-time init on valid repo seeds layout and exits 0', async () => {
  // Regression test for Hole 1: assertDevmateReady must NOT block a fresh repo.
  // A brand-new repo has no .devmate layout yet; init must complete before
  // readiness is checked. This test verifies the happy path exits 0.
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidEnvironment(root);
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0 on first-time init; stderr: ${stderr.get()}`);
  } finally {
    cleanup();
  }
});

test('session-start — second SessionStart on a seeded valid repo also exits 0 (warm session)', async () => {
  // Regression test for Hole 1 warm-session path: after layout exists,
  // readiness is checked first; a valid environment must still exit 0.
  const { root, cleanup } = makeRoot();
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
  try {
    seedValidEnvironment(root);

    // First call — seeds the layout.
    const stdout1 = collectingWritable();
    const stderr1 = collectingWritable();
    const code1 = await runWithIO(stringReadable(payload), stdout1.stream, stderr1.stream);
    assert.equal(code1, 0, `first call should exit 0; stderr: ${stderr1.get()}`);

    // Second call — layout already exists; warm-session readiness check runs.
    const stdout2 = collectingWritable();
    const stderr2 = collectingWritable();
    const code2 = await runWithIO(stringReadable(payload), stdout2.stream, stderr2.stream);
    assert.equal(code2, 0, `warm session should exit 0; stderr: ${stderr2.get()}`);
  } finally {
    cleanup();
  }
});

// ---- Fresh-repo failure paths (no valid env) ----

test('session-start — SessionStart payload seeds the layout and exits 1 on startup failure', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

test('session-start — runs from a subfolder and exits 1 on startup failure', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const sub = join(root, 'src', 'nested');
    mkdirSync(sub, { recursive: true });
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: sub });

    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);
    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

// ---- Non-SessionStart events ----

test('session-start — empty stdin exits 0 (uses process.cwd fallback)', async () => {
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  const code = await runWithIO(stringReadable(''), stdout.stream, stderr.stream);
  assert.equal(code, 0);
});

test('session-start — malformed JSON exits 0 without crashing', async () => {
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  const code = await runWithIO(stringReadable('{ not json'), stdout.stream, stderr.stream);
  assert.equal(code, 0);
  assert.match(stderr.get(), /malformed stdin JSON/);
});

test('session-start — non-SessionStart event is a no-op', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0);
    // Nothing seeded for an unrelated event.
    assert.ok(!existsSync(join(root, '.devmate')), 'seeded layout for a non-SessionStart event');
  } finally {
    cleanup();
  }
});

// ---- Warm-session failure paths ----

test('session-start — second SessionStart call exits 1 on startup failure (no valid env)', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const first = collectingWritable();
    const second = collectingWritable();
    const stderr = collectingWritable();

    await runWithIO(stringReadable(payload), first.stream, stderr.stream);
    const code = await runWithIO(stringReadable(payload), second.stream, stderr.stream);

    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

test('session-start — init failure surfaces warning JSON to stdout, exits 1', async () => {
  // Simulate a permission-denied scenario on non-Windows by making the root
  // dir read-only so mkdir inside .devmate will fail.
  // Skip on Windows because chmod 0o444 does not block directory creation.
  if (platform() === 'win32') return;

  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    // Make root read-only so ensureDevmateLayout cannot create subdirs.
    chmodSync(root, 0o555);
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 1, 'startup check should fail before init failure logic');
  } finally {
    // Restore permissions so cleanup can delete the temp dir.
    try { chmodSync(root, 0o755); } catch { /* best-effort */ }
    cleanup();
  }
});

test('session-start — resolved repoRoot is logged to stderr', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);
    assert.match(stderr.get(), /resolved repoRoot/, 'repoRoot should be logged to stderr for diagnostics');
  } finally {
    cleanup();
  }
});

// ---- E13-2 persona instructionFile validation at session start ----

test('session-start - warns (exit 0) when instructionFile is declared but missing', async () => {
  // E13-2: a declared-but-missing instructionFile degrades to a no-op at
  // dispatch time, so it is advisory only — never a hard failure. This test
  // previously asserted exit 1 "because hooks.json is missing", which was the
  // #72 bug (plugin manifest looked for inside the consumer's repo) rather
  // than the behavior under test.
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    // Write a devmate.config.json that declares an instructionFile that does NOT exist.
    const cfgPath = join(root, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(cfgPath), { recursive: true });
    const cfg = {
      schemaVersion: 1,
      personas: [
        {
          persona: 'backend',
          editableGlobs: ['src/**'],
          instructionFile: 'docs/devmate/backend-instructions.md',
        },
      ],
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `missing instructionFile must not hard-fail; stderr: ${stderr.get()}`);
    assert.match(stdout.get(), /instructionFile\(s\) declared but missing on disk/);
    assert.match(stdout.get(), /backend/);
  } finally {
    cleanup();
  }
});

test('session-start - does not warn when instructionFile is null', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const cfgPath = join(root, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(cfgPath), { recursive: true });
    const cfg = {
      schemaVersion: 1,
      personas: [
        { persona: 'backend', editableGlobs: ['src/**'], instructionFile: null },
      ],
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `stderr: ${stderr.get()}`);
    assert.doesNotMatch(stdout.get(), /instructionFile\(s\) declared but missing on disk/);
  } finally {
    cleanup();
  }
});

test('session-start - does not hard-fail when instructionFile points to missing file', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const cfgPath = join(root, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(cfgPath), { recursive: true });
    const cfg = {
      schemaVersion: 1,
      personas: [
        {
          persona: 'backend',
          editableGlobs: ['src/**'],
          instructionFile: 'docs/missing.md',
        },
        {
          persona: 'frontend',
          editableGlobs: ['src/**'],
          instructionFile: 'docs/also-missing.md',
        },
      ],
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    // Missing instruction files are advisory: they warn, they never change the
    // exit code. Both personas must be named in the warning.
    assert.equal(code, 0, `stderr: ${stderr.get()}`);
    assert.match(stdout.get(), /instructionFile\(s\) declared but missing on disk: backend, frontend/);
  } finally {
    cleanup();
  }
});

test('session-start - a config without verification.unitTest is still ready (exit 0)', async () => {
  // `verification` is optional; its absence is not a startup failure. The old
  // exit-1 expectation here was the missing-hooks.json artifact of #72.
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    const cfgPath = join(root, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(cfgPath), { recursive: true });
    const cfg = {
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `stderr: ${stderr.get()}`);
  } finally {
    cleanup();
  }
});

// ---- B3: multi-root scoped per-repo MEMORY.md pre-loading ----

/**
 * Parse the newline-delimited JSON objects a session-start run writes to
 * stdout and return the first one that carries a `repoMemories` key.
 * @param {string} out
 * @returns {Record<string, unknown> | undefined}
 */
function findRepoMemoriesLine(out) {
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    /** @type {Record<string, unknown>} */
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'repoMemories')) return obj;
  }
  return undefined;
}

/**
 * Seed a fully-valid multi-root devmate CONSUMER workspace into `root`:
 *   - .devmate/devmate.config.json with mode: 'multi-root' and the given personas
 * Each repo subdir is created; the caller writes per-repo MEMORY.md as needed.
 *
 * As with seedValidEnvironment, no `hooks/`/`scripts/` are seeded — they are
 * plugin-shipped, not part of a consumer workspace (#72).
 * @param {string} root
 * @param {{ persona: string, repo: string }[]} personas
 */
function seedValidMultiRootEnvironment(root, personas) {
  const repos = [...new Set(personas.map((p) => p.repo))];
  for (const repo of repos) {
    mkdirSync(join(root, repo), { recursive: true });
  }

  const devmateDir = join(root, '.devmate');
  mkdirSync(devmateDir, { recursive: true });
  writeFileSync(
    join(devmateDir, 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'multi-root',
      primary: repos[0],
      repos,
      personas: personas.map((p) => ({
        persona: p.persona,
        repo: p.repo,
        editableGlobs: [`${p.repo}/**`],
      })),
      verification: { unitTest: 'node --test' },
    }),
  );
}

/**
 * Write a scoped MEMORY.md into a repo subdir under `root`.
 * @param {string} root
 * @param {string} repo
 * @param {string} contents
 */
function writeRepoMemory(root, repo, contents) {
  const dir = join(root, repo, '.devmate');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), contents, 'utf8');
}

test('session-start — multi-root: repoMemories map keyed by repo name with exact contents', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidMultiRootEnvironment(root, [
      { persona: 'backend', repo: 'portals-api' },
      { persona: 'frontend', repo: 'portals-ui' },
    ]);
    const apiMem = '# portals-api memory\n- fact A\n';
    const uiMem = '# portals-ui memory\n- fact B\n';
    writeRepoMemory(root, 'portals-api', apiMem);
    writeRepoMemory(root, 'portals-ui', uiMem);

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    const line = findRepoMemoriesLine(stdout.get());
    assert.ok(line, 'a stdout line with repoMemories should be emitted in multi-root mode');
    assert.deepEqual(line.repoMemories, { 'portals-api': apiMem, 'portals-ui': uiMem });
  } finally {
    cleanup();
  }
});

test('session-start — multi-root: repo missing its MEMORY.md is absent from the map, session succeeds', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidMultiRootEnvironment(root, [
      { persona: 'backend', repo: 'portals-api' },
      { persona: 'frontend', repo: 'portals-ui' },
    ]);
    const apiMem = '# portals-api memory\n';
    writeRepoMemory(root, 'portals-api', apiMem);
    // portals-ui intentionally has no .devmate/MEMORY.md

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    const line = findRepoMemoriesLine(stdout.get());
    assert.ok(line, 'repoMemories line should still be emitted');
    assert.deepEqual(line.repoMemories, { 'portals-api': apiMem });
    assert.ok(
      !Object.prototype.hasOwnProperty.call(line.repoMemories, 'portals-ui'),
      'repo with no MEMORY.md must be absent from the map',
    );
  } finally {
    cleanup();
  }
});

test('session-start — multi-root: two personas sharing a repo yield a single entry, no error', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidMultiRootEnvironment(root, [
      { persona: 'backend', repo: 'portals-api' },
      { persona: 'db', repo: 'portals-api' },
    ]);
    const apiMem = '# shared portals-api memory\n';
    writeRepoMemory(root, 'portals-api', apiMem);

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    const line = findRepoMemoriesLine(stdout.get());
    assert.ok(line, 'repoMemories line should be emitted');
    assert.deepEqual(line.repoMemories, { 'portals-api': apiMem });
    assert.equal(Object.keys(/** @type {object} */ (line.repoMemories)).length, 1);
  } finally {
    cleanup();
  }
});

test('session-start — single-root: NO repoMemories key is emitted (behavior unchanged)', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidEnvironment(root);
    // A workspace-level MEMORY.md must not trigger any repoMemories emission.
    const devmateDir = join(root, '.devmate');
    writeFileSync(join(devmateDir, 'MEMORY.md'), '# workspace memory\n', 'utf8');

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    const line = findRepoMemoriesLine(stdout.get());
    assert.equal(line, undefined, 'single-root mode must not emit a repoMemories key');
  } finally {
    cleanup();
  }
});

// ---- Single-root memory injection (recall) ----

test('session-start — single-root: injects a bounded <devmate-memory> block from repo.jsonl', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidEnvironment(root);
    // The fact's source must resolve to live code — injection verifies
    // before use and drops drifted facts.
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'auth.mjs'), 'export const rs256 = true;\n', 'utf8');
    const repoDir = join(root, '.devmate', 'state', 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, 'repo.jsonl'),
      JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:abcd1234',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: [],
        summary: 'uses JWT RS256',
        confidence: 0.8,
        ts: 1782812345678,
        stepId: '1',
        firstEdit: true,
      }) + '\n',
      'utf8',
    );

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    const out = stdout.get();
    assert.match(out, /<devmate-memory>/);
    assert.match(out, /<\/devmate-memory>/);
    assert.match(out, /lib\/auth\.mjs/);
    assert.match(out, /uses JWT RS256/);
  } finally {
    cleanup();
  }
});

test('session-start — single-root: no <devmate-memory> block when the repo ledger is empty/absent', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidEnvironment(root);
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `expected exit 0; stderr: ${stderr.get()}`);
    assert.ok(
      !stdout.get().includes('<devmate-memory>'),
      'must not inject an empty memory block',
    );
  } finally {
    cleanup();
  }
});

// ── #171: SessionStart surfaces a corrupt task.json via the unreadable-state anchor ──

test('session-start — an invalid (lane, gate) task.json surfaces the #129 diagnostic at session start (#171)', async () => {
  const { root, cleanup } = makeRoot();
  const stdout = collectingWritable();
  const stderr = collectingWritable();
  try {
    seedValidEnvironment(root);
    // A valid-JSON, valid-enum state whose (lane, gate) PAIR is illegal — the
    // #129 hand-edited corruption. Seeded before the SessionStart runs.
    mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId: 't-171',
        lane: 'bug',
        workflowGate: 'discovery-done',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 0,
        budget: 10,
        schemaVersion: 1,
      }),
      'utf8',
    );
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: root });
    const code = await runWithIO(stringReadable(payload), stdout.stream, stderr.stream);

    assert.equal(code, 0, `session start must not crash on a corrupt state; stderr: ${stderr.get()}`);
    const out = stdout.get();
    assert.match(out, /state: unreadable/, '#171 — the unreadable-state anchor is emitted');
    assert.match(out, /has no transitions defined for lane "bug"/, '#171 — the #129 diagnostic reaches the model');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #149 — single-root fresh-clone memory recall fallback.

/**
 * @param {{ source: string, summary: string, ts?: number }} f
 * @returns {string}
 */
function ledgerFactLine(f) {
  return `${JSON.stringify({
    event: 'fact',
    key: `${f.source}:${f.ts ?? 1}`,
    source: f.source,
    tool: 'discovery-merge',
    lane: 'feature',
    tags: [],
    summary: f.summary,
    confidence: 0.9,
    ts: f.ts ?? 1,
    stepId: '1',
    firstEdit: true,
    taskId: 'task-1',
  })}\n`;
}

test('#149 emitMemoryContext: a fresh clone (ledger absent, MEMORY.md present) injects a bounded committed-memory block', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // A cold checkout: the committed memory file is present, but the git-ignored
    // ledger never landed. No .devmate/state/repo/repo.jsonl exists.
    mkdirSync(join(root, '.devmate'), { recursive: true });
    writeFileSync(
      resolve(root, _MEMORY_PATH),
      [
        '# Memory',
        '',
        '<!-- devmate:facts:start -->',
        '## lib/auth.mjs',
        '- uses JWT RS256 (task: t1, added: 2026-01-01T00:00:00.000Z)',
        '<!-- devmate:facts:end -->',
      ].join('\n'),
      'utf8',
    );
    assert.equal(existsSync(repoLedgerPath(root)), false, 'precondition: ledger absent');

    const out = collectingWritable();
    const err = collectingWritable();
    await emitMemoryContext(root, out.stream, err.stream);

    const text = out.get();
    assert.match(text, /<devmate-memory>/, 'a recall block is injected on a cold clone');
    assert.match(text, /fresh checkout/, 'the fallback header identifies the committed-memory source');
    assert.match(text, /uses JWT RS256/, 'the committed fact reaches the model');
  } finally {
    cleanup();
  }
});

test('#149 emitMemoryContext: when the ledger EXISTS, the scored path is used and the fallback is NOT taken', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // The fact's source must resolve to live code (verify-before-use), so create it.
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'x.mjs'), '// x\n', 'utf8');
    mkdirSync(dirname(repoLedgerPath(root)), { recursive: true });
    writeFileSync(repoLedgerPath(root), ledgerFactLine({ source: 'lib/x.mjs', summary: 'x does a thing' }), 'utf8');
    // A committed MEMORY.md ALSO exists — the fallback must NOT win over the ledger.
    mkdirSync(join(root, '.devmate'), { recursive: true });
    writeFileSync(
      resolve(root, _MEMORY_PATH),
      '# Memory\n\n<!-- devmate:facts:start -->\n## other.mjs\n- fresh checkout marker text\n<!-- devmate:facts:end -->\n',
      'utf8',
    );

    const out = collectingWritable();
    const err = collectingWritable();
    await emitMemoryContext(root, out.stream, err.stream);

    const text = out.get();
    assert.match(text, /Recalled facts/, 'the scored recall header is used when the ledger exists');
    assert.match(text, /x does a thing/, 'the scored fact is injected');
    assert.doesNotMatch(text, /fresh checkout/, 'the committed-memory fallback is NOT taken when the ledger exists');
  } finally {
    cleanup();
  }
});

test('#149 emitMemoryContext: a present-but-empty ledger injects nothing (empty is distinct from absent)', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // Ledger file exists but has no facts — a legitimate "nothing yet" state, NOT
    // a fresh clone. The fallback must not fire.
    mkdirSync(dirname(repoLedgerPath(root)), { recursive: true });
    writeFileSync(repoLedgerPath(root), '', 'utf8');
    mkdirSync(join(root, '.devmate'), { recursive: true });
    writeFileSync(
      resolve(root, _MEMORY_PATH),
      '# Memory\n\n<!-- devmate:facts:start -->\n## a.mjs\n- committed note\n<!-- devmate:facts:end -->\n',
      'utf8',
    );

    const out = collectingWritable();
    const err = collectingWritable();
    await emitMemoryContext(root, out.stream, err.stream);

    assert.equal(out.get(), '', 'a present-but-empty ledger yields no recall block');
  } finally {
    cleanup();
  }
});

test('#149 emitMemoryContext: the fresh-clone fallback is bounded — a large MEMORY.md is clipped, never dumped whole', async () => {
  const { root, cleanup } = makeRoot();
  try {
    mkdirSync(join(root, '.devmate'), { recursive: true });
    /** @type {string[]} */
    const lines = ['# Memory', '', '<!-- devmate:facts:start -->'];
    for (let i = 0; i < 120; i += 1) lines.push(`- fact ${i}`);
    lines.push('<!-- devmate:facts:end -->');
    writeFileSync(resolve(root, _MEMORY_PATH), lines.join('\n'), 'utf8');

    const out = collectingWritable();
    const err = collectingWritable();
    await emitMemoryContext(root, out.stream, err.stream);

    const text = out.get();
    assert.match(text, /<devmate-memory>/);
    assert.match(text, /more line\(s\) in the committed memory file/, 'the block is clipped with a truncation marker');
    // The injected block is far smaller than the source file.
    assert.ok(text.split('\n').length < 120, 'the injected block is bounded, not the whole file');
  } finally {
    cleanup();
  }
});
