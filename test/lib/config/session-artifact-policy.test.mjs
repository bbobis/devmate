// @ts-check
/**
 * #93: the session-artifact protection policy is a real config key with a
 * protective default — not an opts bag no producer ever filled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSessionArtifactPolicy,
  validateDevmateConfig,
} from '../../../lib/config/devmate-config.mjs';
import {
  DEFAULT_SESSION_ARTIFACT_PATHS,
  DEFAULT_SESSION_ARTIFACT_WRITERS,
} from '../../../lib/gate-guard-core.mjs';

/**
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
function config(extra = {}) {
  return {
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }],
    ...extra,
  };
}

test('an unconfigured repo gets the protective defaults, never an empty list', () => {
  const policy = resolveSessionArtifactPolicy(config());
  assert.deepEqual(policy.paths, DEFAULT_SESSION_ARTIFACT_PATHS);
  assert.deepEqual(policy.writers, DEFAULT_SESSION_ARTIFACT_WRITERS);
});

test('a null/absent config still gets the defaults (the guard fails closed)', () => {
  const policy = resolveSessionArtifactPolicy(null);
  assert.deepEqual(policy.paths, DEFAULT_SESSION_ARTIFACT_PATHS);
});

test('a repo may declare its own protected paths and writers', () => {
  const policy = resolveSessionArtifactPolicy(
    config({
      sessionArtifactPaths: ['.devmate/state/**'],
      sessionArtifactWriters: [{ glob: '.devmate/state/notes.md', agents: ['planner'] }],
    }),
  );
  assert.deepEqual(policy.paths, ['.devmate/state/**']);
  assert.deepEqual(policy.writers, [{ glob: '.devmate/state/notes.md', agents: ['planner'] }]);
});

test('validate — a well-formed policy is accepted', () => {
  const result = validateDevmateConfig(
    config({
      sessionArtifactPaths: ['.devmate/state/**', '.devmate/session/**'],
      sessionArtifactWriters: [{ glob: '**/spec.md', agents: ['spec-writer'] }],
    }),
  );
  assert.equal(result.ok, true);
});

test('validate — a malformed policy fails closed rather than half-loading', () => {
  // A writer roster read halfway is a boundary widened by accident.
  for (const bad of [
    { sessionArtifactPaths: '.devmate/state/**' },
    { sessionArtifactPaths: [''] },
    { sessionArtifactWriters: [{ glob: '**/spec.md' }] },
    { sessionArtifactWriters: [{ glob: '', agents: ['spec-writer'] }] },
    { sessionArtifactWriters: [{ glob: '**/spec.md', agents: [42] }] },
    { sessionArtifactWriters: [{ glob: '**/spec.md', agents: 'spec-writer' }] },
  ]) {
    const result = validateDevmateConfig(config(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});
