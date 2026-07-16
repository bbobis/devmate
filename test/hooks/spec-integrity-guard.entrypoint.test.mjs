// @ts-check
/**
 * #75 — the spec-integrity guard was REGISTERED and INERT.
 *
 * `hooks/hooks.json` lists it as a PostToolUse command, so VS Code spawned it on
 * every tool call. It had no `main()` and no self-invoke guard, so node loaded
 * the module, defined its functions, and exited 0 having read no stdin and taken
 * no action. The human spec-approval gate — devmate's one mandatory checkpoint —
 * was therefore unprotected: a silent post-approval edit to spec.md was caught by
 * nothing (`lib/gate-guard-core.mjs` has no spec rules, and
 * `lib/gate-preconditions.mjs` compares a self-declared digest rather than
 * re-hashing the file).
 *
 * The pre-existing suite passed throughout, because it imports
 * `handlePostToolUse` and calls it directly — it never spawns the file the way
 * the host does. That is the gap this suite closes: every assertion here goes
 * through the real process boundary.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'spec-integrity-guard.mjs');

const SPEC_ORIGINAL = '# Spec\n\nOriginal, approved by a human.\n';
const SPEC_TAMPERED = '# Spec\n\nQuietly changed AFTER approval.\n';

/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Seed a workspace whose gate is `spec-approved` and whose recorded digest
 * matches `specBody`.
 * @param {{ specBody?: string, gate?: string }} [opts]
 */
function fixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sig-entry-'));
  const stateDir = join(root, '.devmate', 'state');
  const sessionDir = join(root, '.devmate', 'session');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const specPath = join(sessionDir, 'spec.md');
  writeFileSync(specPath, opts.specBody ?? SPEC_ORIGINAL, 'utf8');

  const statePath = join(stateDir, 'task.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      taskId: 'feat-75',
      lane: 'feature',
      workflowGate: opts.gate ?? 'spec-approved',
      artifactHashes: {
        spec: '.devmate/session/spec.md',
        // Digest of the APPROVED body — a later edit must invalidate it.
        specDigest: sha256(SPEC_ORIGINAL),
      },
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return { root, specPath, statePath };
}

/**
 * Spawn the hook exactly as VS Code does: `node <file>`, payload on stdin.
 * @param {unknown} payload
 * @param {string} cwd
 */
function spawnHook(payload, cwd) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

/** @param {string} statePath */
const gateOf = (statePath) => JSON.parse(readFileSync(statePath, 'utf8')).workflowGate;

test(
  'spawned as a hook, a post-approval spec edit rolls the gate back',
  skipUnlessNode(24),
  () => {
    const fx = fixture();
    try {
      // The human approved SPEC_ORIGINAL. Something then rewrote spec.md.
      writeFileSync(fx.specPath, SPEC_TAMPERED, 'utf8');
      assert.equal(gateOf(fx.statePath), 'spec-approved', 'precondition');

      const r = spawnHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'replace_string_in_file',
          tool_input: { filePath: fx.specPath },
          cwd: fx.root,
        },
        fx.root,
      );

      assert.equal(r.status, 0);
      // Before #75 this hook produced NO output and left task.json byte-identical.
      assert.match(r.stdout, /rolled back to spec-draft/i);
      assert.equal(
        gateOf(fx.statePath),
        'spec-draft',
        'a tampered spec must invalidate the approval — nothing else in the system re-hashes the file',
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  },
);

test('spawned as a hook, an UNCHANGED spec leaves the gate alone', skipUnlessNode(24), () => {
  const fx = fixture();
  try {
    // spec.md still matches its recorded digest: a write that changed nothing.
    const r = spawnHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'replace_string_in_file',
        tool_input: { filePath: fx.specPath },
        cwd: fx.root,
      },
      fx.root,
    );
    assert.equal(r.status, 0);
    assert.equal(gateOf(fx.statePath), 'spec-approved', 'no spurious rollback');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a write to an unrelated file is a no-op', skipUnlessNode(24), () => {
  const fx = fixture();
  try {
    writeFileSync(fx.specPath, SPEC_TAMPERED, 'utf8');
    const r = spawnHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'replace_string_in_file',
        tool_input: { filePath: join(fx.root, 'lib', 'unrelated.mjs') },
        cwd: fx.root,
      },
      fx.root,
    );
    assert.equal(r.status, 0);
    // The guard keys on the spec path; an edit elsewhere must not roll anything
    // back, even though spec.md happens to be dirty.
    assert.equal(gateOf(fx.statePath), 'spec-approved');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('malformed and empty stdin exit 0 without blocking the tool call', skipUnlessNode(24), () => {
  const fx = fixture();
  try {
    for (const input of ['', '{ not json !!']) {
      const r = spawnSync('node', [HOOK], {
        input,
        cwd: fx.root,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 0, `input ${JSON.stringify(input)} must not fail the hook`);
      assert.equal(gateOf(fx.statePath), 'spec-approved');
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the root is climbed out of .devmate — not anchored on a bare cwd', skipUnlessNode(24), () => {
  const fx = fixture();
  try {
    writeFileSync(fx.specPath, SPEC_TAMPERED, 'utf8');
    // VS Code makes the workspace's own .devmate/ folder the cwd whenever it is
    // the first workspace folder. The handler's old `?? "."` default anchored on
    // whatever cwd happened to be, so it would look for state under
    // .devmate/.devmate/ and find nothing.
    const devmateDir = join(fx.root, '.devmate');
    const r = spawnHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'replace_string_in_file',
        tool_input: { filePath: fx.specPath },
        cwd: devmateDir,
      },
      devmateDir,
    );
    assert.equal(r.status, 0);
    assert.equal(
      gateOf(fx.statePath),
      'spec-draft',
      'must still find task.json when cwd IS the .devmate folder',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
