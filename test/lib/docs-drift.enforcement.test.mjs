// @ts-check
/**
 * E9-30: PATTERNS.md enforcement-status honesty. The extractor parses each
 * pattern block's Enforcement claim; the validator rejects out-of-vocabulary
 * values, missing file:line pointers, and machine-verifiable wiring lies
 * (ci-enforced without a CI step, hook-runtime without a hook registration).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENFORCEMENT_LEVELS,
  extractEnforcementClaims,
  validateEnforcementClaims,
} from '../../lib/docs-drift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** @param {string} enforcementLine @returns {string} */
function patternDoc(enforcementLine) {
  return [
    '### P99 — Synthetic pattern',
    '',
    '- **What:** synthetic.',
    '- **Benefit:** synthetic.',
    enforcementLine,
    '',
  ].join('\n');
}

const CI_TEXT = 'run: node scripts/worker-contract-check.mjs\nrun: npm test\n';
const HOOKS_TEXT = '"command": "node hooks/contract-validator.mjs"\n';

test('extracts pattern, level, and pointer', () => {
  const claims = extractEnforcementClaims(
    patternDoc('- **Enforcement:** `structural` (`lib/task-state.mjs:231`) — locked writes.')
  );
  assert.equal(claims.length, 1);
  assert.deepEqual(
    { pattern: claims[0]?.pattern, level: claims[0]?.level, pointer: claims[0]?.pointer },
    { pattern: 'P99', level: 'structural', pointer: 'lib/task-state.mjs:231' }
  );
});

test('rejects out-of-vocabulary enforcement value', () => {
  const claims = extractEnforcementClaims(
    patternDoc('- **Enforcement:** `wired` (`lib/task-state.mjs:231`)')
  );
  const violations = validateEnforcementClaims(claims, { ciText: CI_TEXT, hooksText: HOOKS_TEXT });
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /not in the vocabulary/);
  for (const level of ENFORCEMENT_LEVELS) {
    assert.notEqual(level, 'wired');
  }
});

test('requires a file:line pointer', () => {
  for (const line of [
    '- **Enforcement:** `structural`',
    '- **Enforcement:** `structural` (`lib/task-state.mjs`)',
  ]) {
    const violations = validateEnforcementClaims(extractEnforcementClaims(patternDoc(line)), {
      ciText: CI_TEXT,
      hooksText: HOOKS_TEXT,
    });
    assert.equal(violations.length, 1, line);
    assert.match(violations[0]?.reason ?? '', /file:line/, line);
  }
});

test('rejects ci-enforced claim with no CI step', () => {
  const claims = extractEnforcementClaims(
    patternDoc('- **Enforcement:** `ci-enforced` (`scripts/ghost-script.mjs:1`) — imaginary step.')
  );
  const violations = validateEnforcementClaims(claims, { ciText: CI_TEXT, hooksText: HOOKS_TEXT });
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /ci-enforced/);
});

test('rejects hook-runtime claim with no hook', () => {
  const claims = extractEnforcementClaims(
    patternDoc('- **Enforcement:** `hook-runtime` (`hooks/ghost-hook.mjs:9`) — imaginary hook.')
  );
  const violations = validateEnforcementClaims(claims, { ciText: CI_TEXT, hooksText: HOOKS_TEXT });
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /hook-runtime/);
});

test('accepts a truthful claim', () => {
  const doc = [
    patternDoc('- **Enforcement:** `ci-enforced` (`scripts/worker-contract-check.mjs:1`)'),
    '### P98 — Another synthetic pattern',
    '',
    '- **Enforcement:** `hook-runtime` (`hooks/contract-validator.mjs:33`)',
    '',
    '### P97 — Structural synthetic pattern',
    '',
    '- **Enforcement:** `aspirational` (`agents/orchestrator.agent.md:46`)',
    '',
  ].join('\n');
  const violations = validateEnforcementClaims(extractEnforcementClaims(doc), {
    ciText: CI_TEXT,
    hooksText: HOOKS_TEXT,
  });
  assert.deepEqual(violations, []);
});

test('a *.test.mjs pointer counts as ci-enforced via npm test', () => {
  const claims = extractEnforcementClaims(
    patternDoc('- **Enforcement:** `ci-enforced` (`evals/token-budget/suite.test.mjs:171`)')
  );
  const violations = validateEnforcementClaims(claims, { ciText: CI_TEXT, hooksText: HOOKS_TEXT });
  assert.deepEqual(violations, []);
});

test('flags a pattern block missing its Enforcement line', () => {
  const doc = '### P96 — Bare pattern\n\n- **What:** nothing else.\n';
  const violations = validateEnforcementClaims(extractEnforcementClaims(doc), {
    ciText: CI_TEXT,
    hooksText: HOOKS_TEXT,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /no Enforcement line/);
});

test('the committed PATTERNS.md passes against the real ci.yml and hooks.json', () => {
  const patternsText = readFileSync(join(REPO_ROOT, 'docs', 'PATTERNS.md'), 'utf8');
  const ciText = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const hooksText = readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8');
  const claims = extractEnforcementClaims(patternsText);
  assert.ok(claims.length >= 24, `found ${claims.length} enforcement claims`);
  const violations = validateEnforcementClaims(claims, { ciText, hooksText });
  assert.deepEqual(violations, []);
});
