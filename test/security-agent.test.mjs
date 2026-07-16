// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertSecurityAgentAvailable,
  createSecurityFindingsArtifact,
  isSecurityRequired,
  validateSecurityFindingsArtifact,
} from '../lib/workflow/agents/security.mjs';
import {
  evaluateSecurityPolicy,
  SECURITY_REQUIRED_PATH_GLOBS,
  SECURITY_REQUIRED_TAGS,
} from '../lib/workflow/lanes/security-policy.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';

/**
 * @returns {string}
 */
function makeTmpRepo() {
  return mkdtempSync(join(tmpdir(), 'devmate-security-agent-'));
}

test('createSecurityFindingsArtifact / computes passed from high-severity findings and captures unverified', () => {
  const artifact = createSecurityFindingsArtifact({
    findings: [
      {
        severity: 'critical',
        description: 'Auth bypass in route guard',
        path: 'lib/auth/check.mjs#L42',
      },
      {
        severity: 'low',
        description: '[UNVERIFIED] Potential path traversal needs runtime repro',
        path: 'lib/fs/sync.mjs#L19',
      },
    ],
  });

  assert.equal(artifact.findings.length, 2);
  assert.equal(artifact.passed, false);
  assert.equal(artifact.unverified.length, 1);
  assert.equal(artifact.unverified[0]?.startsWith('[UNVERIFIED]'), true);
});

test('validateSecurityFindingsArtifact / rejects malformed severity/path and passed mismatch', () => {
  const verdict = validateSecurityFindingsArtifact({
    findings: [
      {
        severity: 'urgent',
        description: 'Bad severity value',
        path: '',
      },
    ],
    passed: true,
    unverified: ['no marker'],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('severity')), true);
  assert.equal(verdict.errors.some((e) => e.includes('.path')), true);
  assert.equal(verdict.errors.some((e) => e.includes('passed must equal')), true);
  assert.equal(verdict.errors.some((e) => e.includes('unverified[0]')), true);
});

test('evaluateSecurityPolicy / required for risky tags and sensitive paths with enriched triggers', () => {
  const byTag = evaluateSecurityPolicy({
    lane: 'feature',
    tags: ['Auth', 'ui'],
    affectedPaths: ['src/ui/form.mjs'],
  });
  assert.equal(byTag.required, true);
  assert.equal(byTag.reason.startsWith('required:tag:'), true);
  assert.equal(byTag.triggeringTags.includes('auth'), true);
  assert.deepEqual(byTag.triggeringPaths, []);

  const byPath = evaluateSecurityPolicy({
    lane: 'bug',
    tags: ['maintenance'],
    affectedPaths: ['src/auth/guard.mjs'],
  });
  assert.equal(byPath.required, true);
  assert.equal(byPath.reason.startsWith('required:path:'), true);
  assert.equal(byPath.triggeringPaths.includes('src/auth/guard.mjs'), true);
  assert.deepEqual(byPath.triggeringTags, []);
});

test('evaluateSecurityPolicy / optional low-risk chore and deterministic trigger exports', () => {
  const policy = evaluateSecurityPolicy({
    lane: 'chore',
    tags: ['docs'],
    affectedPaths: ['docs/README.md'],
  });

  assert.equal(policy.required, false);
  assert.equal(policy.reason, 'optional:default-low-risk');
  assert.deepEqual(policy.triggeringPaths, []);
  assert.deepEqual(policy.triggeringTags, []);

  assert.equal(SECURITY_REQUIRED_TAGS.has('auth'), true);
  assert.equal(SECURITY_REQUIRED_PATH_GLOBS.length > 0, true);
  assert.equal(isSecurityRequired({ lane: 'feature', tags: ['secrets'], affectedPaths: [] }), true);
});

test('E2E / required feature policy and existing security agent satisfy dispatch contract', () => {
  const policy = evaluateSecurityPolicy({
    lane: 'feature',
    tags: ['data-exposure'],
    affectedPaths: ['src/service/client.mjs'],
  });

  assert.equal(policy.required, true);

  const dispatchVerdict = assertDispatchResult('security', {
    status: 'ok',
    payload: {
      findings: [
        {
          severity: 'medium',
          description: 'External API response handling lacks explicit allowlist',
          path: 'src/service/client.mjs#L31',
        },
      ],
    },
  });

  assert.equal(dispatchVerdict.ok, true);
});

test('negative / required policy with missing security agent file halts clearly', () => {
  const repoRoot = makeTmpRepo();
  try {
    const policy = evaluateSecurityPolicy({
      lane: 'feature',
      tags: ['auth'],
      affectedPaths: ['src/security/session.mjs'],
    });
    assert.equal(policy.required, true);

    const guard = assertSecurityAgentAvailable(repoRoot);
    assert.equal(guard.ok, false);
    const message = guard.error ?? '';
    assert.equal(message.includes('security.agent.md'), true);
    assert.equal(message.includes(repoRoot), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('regression / low-risk chore bypasses security and does not require agent file', () => {
  const repoRoot = makeTmpRepo();
  try {
    const agentDir = join(repoRoot, 'agents');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'placeholder.txt'), 'x\n', 'utf8');

    const policy = evaluateSecurityPolicy({
      lane: 'chore',
      tags: ['docs'],
      affectedPaths: ['docs/CONTRIBUTING.md'],
    });
    assert.equal(policy.required, false);

    // Optional security path: orchestrator should bypass without checking missing agent.
    const shouldCheckAgent = policy.required;
    assert.equal(shouldCheckAgent, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
