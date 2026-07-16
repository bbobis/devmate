// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDocsClaims, diffClaims, buildGroundTruth } from '../../lib/docs-drift.mjs';

/** @typedef {import('../../lib/types.mjs').DocsClaim} DocsClaim */

/**
 * Create a unique temp directory for a test.
 * @returns {string}
 */
function makeTempDir() {
  const dir = resolve(tmpdir(), `docs-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// buildGroundTruth
// ---------------------------------------------------------------------------

describe('buildGroundTruth', () => {
  it('returns a map containing hook-event entries matching the hook manifest', async () => {
    const dir = makeTempDir();
    try {
      const hooksPath = resolve(dir, 'hooks.json');
      writeFileSync(
        hooksPath,
        JSON.stringify({
          schemaVersion: 1,
          hooks: {
            PostToolUse: [{ type: 'command', event: 'PostToolUse', command: 'scripts/x.mjs' }],
            Stop: [{ type: 'command', event: 'Stop', command: 'scripts/y.mjs' }],
          },
        }),
        'utf8'
      );
      // configSchemaPath intentionally points at a missing file → skipped.
      const groundTruth = await buildGroundTruth({
        hooksPath,
        configSchemaPath: resolve(dir, 'missing-config.json'),
      });
      const events = groundTruth.get('hook-event');
      assert.ok(Array.isArray(events), 'hook-event entry should exist');
      assert.ok(events.includes('PostToolUse'), 'manifest event PostToolUse present');
      assert.ok(events.includes('Stop'), 'manifest event Stop present');
      // No config schema file → no config-key entry.
      assert.equal(groundTruth.has('config-key'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractDocsClaims
// ---------------------------------------------------------------------------

describe('extractDocsClaims', () => {
  it('extracts a known event name from a fixture markdown file at the correct line number', async () => {
    const dir = makeTempDir();
    try {
      const file = resolve(dir, 'fixture.md');
      // The event name appears on line 3 (1-based).
      writeFileSync(file, '# Heading\n\nThe `PostToolUse` hook fires after a tool runs.\n', 'utf8');
      const claims = await extractDocsClaims(file);
      const eventClaim = claims.find((c) => c.value === 'PostToolUse');
      assert.ok(eventClaim, 'should extract the PostToolUse claim');
      assert.equal(eventClaim.claimType, 'hook-event');
      assert.equal(eventClaim.line, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts a config key code span', async () => {
    const dir = makeTempDir();
    try {
      const file = resolve(dir, 'fixture.md');
      writeFileSync(file, 'Set `maxRetries` to control reruns.\n', 'utf8');
      const claims = await extractDocsClaims(file);
      const keyClaim = claims.find((c) => c.value === 'maxRetries');
      assert.ok(keyClaim, 'should extract the maxRetries claim');
      assert.equal(keyClaim.claimType, 'config-key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores inline code that is not a recognized pattern', async () => {
    const dir = makeTempDir();
    try {
      const file = resolve(dir, 'fixture.md');
      // File paths, shell commands, and all-caps tokens are not recognized.
      writeFileSync(
        file,
        'Run `npm run verify` and edit `scripts/post-tool-use.mjs`; see `README`.\n',
        'utf8'
      );
      const claims = await extractDocsClaims(file);
      const recognized = claims.filter((c) => ['hook-event', 'config-key'].includes(c.claimType));
      assert.equal(recognized.length, 0, `expected no recognized claims, got ${JSON.stringify(recognized)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// diffClaims
// ---------------------------------------------------------------------------

describe('diffClaims', () => {
  it('returns empty violations for claims that match ground truth', () => {
    /** @type {DocsClaim[]} */
    const claims = [
      { file: 'a.md', line: 1, claimType: 'hook-event', value: 'PostToolUse' },
    ];
    const groundTruth = new Map([['hook-event', ['PostToolUse', 'Stop']]]);
    const violations = diffClaims(claims, groundTruth);
    assert.deepEqual(violations, []);
  });

  it('returns a violation with reason for a claim whose value is not in the ground truth set', () => {
    /** @type {DocsClaim[]} */
    const claims = [
      { file: 'a.md', line: 7, claimType: 'hook-event', value: 'PreToolCall' },
    ];
    const groundTruth = new Map([['hook-event', ['PostToolUse', 'Stop']]]);
    const violations = diffClaims(claims, groundTruth);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].claim.value, 'PreToolCall');
    assert.ok(violations[0].reason.includes('PreToolCall'), 'reason mentions the bad value');
  });

  it('passes through claims whose type is not in the ground truth map', () => {
    /** @type {DocsClaim[]} */
    const claims = [
      { file: 'a.md', line: 2, claimType: 'config-key', value: 'someKey' },
    ];
    const groundTruth = new Map([['hook-event', ['PostToolUse']]]);
    const violations = diffClaims(claims, groundTruth);
    assert.deepEqual(violations, []);
  });
});
