// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEditAllowedAtGate, checkSpecApprovedPrecondition } from '../../lib/gate-guard.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- isEditAllowedAtGate ----

test('gate-guard › source edit blocked when gate is spec-approved (before impl-started)', () => {
  assert.equal(isEditAllowedAtGate('spec-approved'), false);
});

test('gate-guard › source edit blocked when gate is spec-draft', () => {
  assert.equal(isEditAllowedAtGate('spec-draft'), false);
});

test('gate-guard › source edit blocked when gate is plan-done', () => {
  assert.equal(isEditAllowedAtGate('plan-done'), false);
});

test('gate-guard › source edit blocked when gate is no-lane', () => {
  assert.equal(isEditAllowedAtGate('no-lane'), false);
});

test('gate-guard › source edit allowed when gate is impl-started', () => {
  assert.equal(isEditAllowedAtGate('impl-started'), true);
});

test('gate-guard › source edit allowed when gate is verification-passed', () => {
  assert.equal(isEditAllowedAtGate('verification-passed'), true);
});

test('gate-guard › source edit allowed when gate is pr-ready', () => {
  assert.equal(isEditAllowedAtGate('pr-ready'), true);
});

test('gate-guard › source edit allowed when gate is done', () => {
  assert.equal(isEditAllowedAtGate('done'), true);
});

// ---- checkSpecApprovedPrecondition ----

test('gate-guard › spec-approved transition denied if spec.md does not exist', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  const result = checkSpecApprovedPrecondition(specPath);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes('spec-approved'));
  assert.ok(!result.ok && result.reason.includes('spec.md'));
  rmSync(dir, { recursive: true, force: true });
});

test('gate-guard › spec-approved transition allowed if spec.md exists', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, '# spec\n');
  const result = checkSpecApprovedPrecondition(specPath);
  assert.equal(result.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('gate-guard › spec-approved transition denied if ui-brief.json is missing', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  const uiBriefPath = join(dir, 'ui-brief.json');
  writeFileSync(specPath, '# spec\n');

  const result = checkSpecApprovedPrecondition(specPath, uiBriefPath);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes('UI brief not found'));
  rmSync(dir, { recursive: true, force: true });
});

test('gate-guard › spec-approved transition denied if ui-brief.json contains invalid JSON', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  const uiBriefPath = join(dir, 'ui-brief.json');
  writeFileSync(specPath, '# spec\n');
  writeFileSync(uiBriefPath, '{invalid-json');

  const result = checkSpecApprovedPrecondition(specPath, uiBriefPath);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes('UI brief is unreadable'));
  rmSync(dir, { recursive: true, force: true });
});

test('gate-guard › spec-approved transition denied if ui-brief.json fails schema validation', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  const uiBriefPath = join(dir, 'ui-brief.json');
  writeFileSync(specPath, '# spec\n');
  writeFileSync(uiBriefPath, JSON.stringify({ screens: ['home'] }, null, 2));

  const result = checkSpecApprovedPrecondition(specPath, uiBriefPath);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes('UI brief is invalid'));
  rmSync(dir, { recursive: true, force: true });
});

test('gate-guard › spec-approved transition allowed if spec.md and valid ui-brief.json exist', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.md');
  const uiBriefPath = join(dir, 'ui-brief.json');
  writeFileSync(specPath, '# spec\n');
  writeFileSync(
    uiBriefPath,
    JSON.stringify(
      {
        screens: ['Home'],
        interactions: ['Open settings'],
        errorStates: ['Network failure'],
        components: ['SettingsPanel'],
        unverified: ['[UNVERIFIED] pending analytics event contract'],
      },
      null,
      2,
    ),
  );

  const result = checkSpecApprovedPrecondition(specPath, uiBriefPath);
  assert.equal(result.ok, true);
  rmSync(dir, { recursive: true, force: true });
});
