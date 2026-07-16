// @ts-check
/**
 * #77 (#82 review) — the dynamic-RegExp guard must scan the file the edit
 * actually touched, whatever shape the path arrives in.
 *
 * Two ways this security hook was blind:
 *
 * 1. Its edit-tool list held four names VS Code has never sent, so of every
 *    write the editor can make it inspected exactly one (`apply_patch`).
 * 2. It anchored a RELATIVE path with `resolve(p)` — i.e. on `process.cwd()`,
 *    which for a hook is the workspace's own `.devmate/` folder. The path became
 *    `<workspace>/.devmate/lib/foo.mjs`, which does not exist, and the guard's
 *    `pathExists` check then skipped it silently. A guard that declines to look
 *    at a file it cannot find is bypassable by the shape of a path — and VS
 *    Code's own `edit_files` example sends relative entries.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', 'scripts', 'posttool-regex-guard.mjs');

/** A file whose content the guard must reject. */
const OFFENDING = 'export const re = new RegExp(userInput);\n';
/** A file the guard must pass. */
const CLEAN = 'export const re = /^[a-z]+$/;\n';

/**
 * Seed a workspace in the monoroot layout and run the guard from the `.devmate`
 * folder — the cwd VS Code really hands a hook there.
 * @param {{ source: string, toolInput: (root: string) => Record<string, unknown>, toolName?: string }} opts
 */
function runGuard(opts) {
  const root = mkdtempSync(join(tmpdir(), 'regex-guard-'));
  const devmateDir = join(root, '.devmate');
  mkdirSync(devmateDir, { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'target.mjs'), opts.source, 'utf8');

  const r = spawnSync('node', [GUARD], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: opts.toolName ?? 'replace_string_in_file',
      tool_input: opts.toolInput(root),
      cwd: devmateDir,
    }),
    cwd: devmateDir,
    encoding: 'utf8',
    timeout: 10000,
  });
  rmSync(root, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('blocks a dynamic RegExp reached by an ABSOLUTE filePath', skipUnlessNode(24), () => {
  const r = runGuard({
    source: OFFENDING,
    toolInput: (root) => ({ filePath: join(root, 'lib', 'target.mjs') }),
  });
  assert.equal(r.status, 2, 'exit 2 is the documented blocking error');
  assert.match(r.stderr, /dynamic RegExp/i);
});

test('blocks a dynamic RegExp reached by a RELATIVE filePath (#82 review)', skipUnlessNode(24), () => {
  // The bypass. cwd is <workspace>/.devmate, so `resolve('lib/target.mjs')` used
  // to produce <workspace>/.devmate/lib/target.mjs — a file that does not exist,
  // which the guard skipped without a word.
  const r = runGuard({
    source: OFFENDING,
    toolInput: () => ({ filePath: 'lib/target.mjs' }),
  });
  assert.equal(
    r.status,
    2,
    'a relative path must be anchored on the workspace root, not the hook cwd',
  );
  assert.match(r.stderr, /dynamic RegExp/i);
});

test('blocks a dynamic RegExp reached through edit_files files[] (relative)', skipUnlessNode(24), () => {
  const r = runGuard({
    source: OFFENDING,
    toolName: 'edit_files',
    toolInput: () => ({ files: ['lib/target.mjs'] }),
  });
  assert.equal(r.status, 2);
});

test('a clean file passes, and says nothing on stdout', skipUnlessNode(24), () => {
  const r = runGuard({
    source: CLEAN,
    toolInput: () => ({ filePath: 'lib/target.mjs' }),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'the host has no field for "carry on"');
});

test('a non-edit tool is not scanned at all', skipUnlessNode(24), () => {
  const r = runGuard({
    source: OFFENDING,
    toolName: 'read_file',
    toolInput: () => ({ filePath: 'lib/target.mjs' }),
  });
  assert.equal(r.status, 0);
});
