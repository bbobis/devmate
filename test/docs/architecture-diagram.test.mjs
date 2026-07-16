// @ts-check
/**
 * E9-29: ARCHITECTURE.md carries the promised mermaid system diagram, the
 * continuous request-flow section, and the rationale — and the drift-prone
 * Core-Principles table stays deleted in favor of the PATTERNS pointer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH = readFileSync(join(__dirname, '..', '..', 'docs', 'ARCHITECTURE.md'), 'utf8');

test('a mermaid system diagram fence is present', () => {
  assert.match(ARCH, /## System diagram/);
  assert.match(ARCH, /```mermaid\nflowchart LR/);
});

test('the continuous request-flow and rationale sections exist', () => {
  assert.match(ARCH, /## Request flow/);
  assert.match(ARCH, /## Why this shape/);
  assert.match(ARCH, /SYSTEM_OVERVIEW\.md/);
});

test('the duplicated Core-Principles table is gone, PATTERNS pointer remains', () => {
  assert.doesNotMatch(ARCH, /## Core Principles/);
  assert.doesNotMatch(ARCH, /\| Pattern \| Rule \|/);
  assert.match(ARCH, /single source of truth for patterns/);
});
