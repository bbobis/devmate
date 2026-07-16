// @ts-check
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROKEN_ENTRY_GUARD,
  findBrokenEntryGuards,
  formatEntryGuardTable,
  findUnrunnableHooks,
} from '../../lib/entry-guard-lint.mjs';

// Assembled from parts so this test file never contains the flagged
// substring itself (the lint scans test/ too).
const BROKEN_LINE = 'if (import.meta.url === `' + BROKEN_ENTRY_GUARD + '`) {\n';
const CORRECT_LINE = 'if (isMainModule(import.meta.url)) {\n';
const FOOTER_BODY = '  assertNodeVersion(24);\n  main(process.argv.slice(2)).then((code) => process.exit(code));\n}\n';

describe('findBrokenEntryGuards', () => {
  const root = mkdtempSync(join(tmpdir(), 'entry-guard-lint-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('returns no violations for a tree using only the correct guard', async () => {
    const dir = join(root, 'clean');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'ok.mjs'), '// @ts-check\n' + CORRECT_LINE + FOOTER_BODY);
    assert.deepEqual(await findBrokenEntryGuards(dir), []);
  });

  it('flags a deliberately reintroduced broken guard with file and line', async () => {
    const dir = join(root, 'dirty');
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'bad.mjs'), '// @ts-check\nexport function main() {}\n' + BROKEN_LINE + FOOTER_BODY);
    const violations = await findBrokenEntryGuards(dir);
    assert.deepEqual(violations, [{ file: 'hooks/bad.mjs', line: 3 }]);
  });

  it('skips node_modules and .claude/worktrees but scans other dot-dirs', async () => {
    const dir = join(root, 'excluded');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(dir, '.claude', 'worktrees', 'stale', 'scripts'), { recursive: true });
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'x.mjs'), BROKEN_LINE);
    writeFileSync(join(dir, '.claude', 'worktrees', 'stale', 'scripts', 'y.mjs'), BROKEN_LINE);
    writeFileSync(join(dir, '.claude', 'skills', 'z.mjs'), BROKEN_LINE);
    const violations = await findBrokenEntryGuards(dir);
    assert.deepEqual(violations, [{ file: '.claude/skills/z.mjs', line: 1 }]);
  });

  it('ignores non-mjs files containing the needle', async () => {
    const dir = join(root, 'non-mjs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), BROKEN_LINE);
    writeFileSync(join(dir, 'legacy.js'), BROKEN_LINE);
    assert.deepEqual(await findBrokenEntryGuards(dir), []);
  });

  it('reports every occurrence when a file has more than one', async () => {
    const dir = join(root, 'multi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'twice.mjs'), BROKEN_LINE + '// filler\n' + BROKEN_LINE);
    const violations = await findBrokenEntryGuards(dir);
    assert.deepEqual(violations, [
      { file: 'twice.mjs', line: 1 },
      { file: 'twice.mjs', line: 3 },
    ]);
  });
});

describe('formatEntryGuardTable', () => {
  it('renders one row per violation naming the fix', () => {
    const table = formatEntryGuardTable([{ file: 'scripts/x.mjs', line: 42 }]);
    const rows = table.split('\n');
    assert.equal(rows.length, 3);
    assert.ok(rows[2].includes('scripts/x.mjs'));
    assert.ok(rows[2].includes('42'));
    assert.ok(rows[2].includes('isMainModule(import.meta.url)'));
  });
});

// ── #75: a REGISTERED hook that cannot execute ──────────────────────────────
// findBrokenEntryGuards greps for a *broken* guard. A file with NO guard is
// invisible to it — which is how hooks/spec-integrity-guard.mjs stayed
// registered-but-inert, leaving the human spec-approval gate unprotected.

describe('findUnrunnableHooks', () => {
  /** @type {string[]} */
  const dirs = [];

  /**
   * Seed a repo root with a hooks manifest and the scripts it names.
   * @bounded-alloc Iterates `scripts`, a literal object authored in this test
   * file (never external input); every case below passes at most one entry.
   * @param {Record<string, string|null>} scripts  relpath -> source, or null to omit the file
   * @returns {string}
   */
  function seed(scripts) {
    const root = mkdtempSync(join(tmpdir(), 'unrunnable-'));
    dirs.push(root);
    /** @type {Record<string, unknown[]>} */
    const hooks = {};
    let i = 0;
    for (const [rel, src] of Object.entries(scripts)) {
      const event = ['PreToolUse', 'PostToolUse', 'SessionStart'][i % 3] ?? 'PreToolUse';
      i++;
      (hooks[event] ??= []).push({
        type: 'command',
        command: `node "\${PLUGIN_ROOT}/${rel}"`,
      });
      if (src === null) continue;
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, src, 'utf8');
    }
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({ schemaVersion: 1, hooks }),
      'utf8',
    );
    return root;
  }

  /** @param {string} root */
  const run = (root) =>
    findUnrunnableHooks(root, {
      loadManifest: (r) =>
        JSON.parse(readFileSync(join(r, 'hooks', 'hooks.json'), 'utf8')),
      extractScriptPath: (cmd) => {
        const m = /\$\{PLUGIN_ROOT\}\/([^"']+)/.exec(cmd);
        return m?.[1] ?? null;
      },
    });

  // Shaped like a real hook — imports included — so the fixture would also run
  // if executed. The lint only greps source text, but a fixture that could not
  // itself run would be a poor witness in a suite about runnability.
  const GOOD =
    "import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';\n" +
    "import { resolveHookRoot } from '../lib/init/repo-root.mjs';\n" +
    'export async function main(_a) { const root = resolveHookRoot(); return root ? 0 : 0; }\n' +
    'if (isMainModule(import.meta.url)) { assertNodeVersion(24); main(process.argv.slice(2)); }\n';

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('passes a hook that exports main() and self-invokes', () => {
    assert.deepEqual(run(seed({ 'hooks/ok.mjs': GOOD })), []);
  });

  it('flags a registered hook with NO main() — the #75 failure mode', () => {
    // 245 lines of correct logic, spawned by the host, doing nothing at all.
    const v = run(seed({ 'hooks/inert.mjs': 'export function handle(e) { return e; }\n' }));
    assert.equal(v.length, 1);
    assert.equal(v[0].file, 'hooks/inert.mjs');
    assert.match(v[0].reason, /exports no main/);
  });

  it('flags a hook that exports main() but never self-invokes', () => {
    const v = run(seed({ 'hooks/nocall.mjs': 'export async function main() { return 0; }\n' }));
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /never self-invokes/);
  });

  it('flags a registered script that does not exist', () => {
    const v = run(seed({ 'hooks/ghost.mjs': null }));
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /does not exist/);
  });

  it('reports the event the broken hook is registered under', () => {
    const v = run(seed({ 'hooks/inert.mjs': 'export const x = 1;\n' }));
    assert.equal(v[0].event, 'PreToolUse');
  });

  it('flags a runnable hook that never resolves a workspace root (#76)', () => {
    // Executes fine — main() + self-invoke — but anchors every .devmate/ path
    // on the unspecified hook cwd. That is the doubled-.devmate failure mode.
    const v = run(
      seed({
        'hooks/rootless.mjs':
          'export async function main(_a) { return 0; }\n' +
          'if (isMainModule(import.meta.url)) { main(process.argv.slice(2)); }\n',
      }),
    );
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /never resolves a workspace root/);
  });

  it('accepts resolveRepoRoot as the resolver too (session-start family)', () => {
    const v = run(
      seed({
        'scripts/session.mjs':
          'export async function main(_a) { const r = await resolveRepoRoot(process.cwd()); return r ? 0 : 0; }\n' +
          'if (isMainModule(import.meta.url)) { main(process.argv.slice(2)); }\n',
      }),
    );
    assert.deepEqual(v, []);
  });

  it('checks the `windows` command override too — a Windows-only drift is caught', () => {
    // Both fields are hand-edited in hooks.json. If `windows` points at a
    // different script that cannot run, POSIX CI stays green while every
    // Windows user gets a registered no-op (#48 was a Windows-only hook break).
    const root = mkdtempSync(join(tmpdir(), 'unrunnable-win-'));
    dirs.push(root);
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'ok.mjs'), GOOD, 'utf8');
    writeFileSync(join(root, 'hooks', 'win-only.mjs'), 'export const broken = 1;\n', 'utf8');
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/hooks/ok.mjs"',
              windows: 'node "${PLUGIN_ROOT}/hooks/win-only.mjs"',
            },
          ],
        },
      }),
      'utf8',
    );
    const v = run(root);
    assert.equal(v.length, 1, 'the windows-only script must be checked');
    assert.equal(v[0].file, 'hooks/win-only.mjs');
    assert.match(v[0].reason, /exports no main/);
  });

  it('dedupes when command and windows name the same script', () => {
    const root = mkdtempSync(join(tmpdir(), 'unrunnable-dedupe-'));
    dirs.push(root);
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'inert.mjs'), 'export const x = 1;\n', 'utf8');
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/hooks/inert.mjs"',
              windows: 'node "${PLUGIN_ROOT}/hooks/inert.mjs"',
            },
          ],
        },
      }),
      'utf8',
    );
    const v = run(root);
    assert.equal(v.length, 1, 'same script in both fields is reported once, not twice');
  });
});
