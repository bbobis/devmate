// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isGateGuardRegistered } from '../../lib/hooks/registry.mjs';

test('isGateGuardRegistered - valid manifest with existing script returns ok:true', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    const scriptsDir = join(tempDir, 'scripts');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/scripts/gate-guard.mjs"',
              windows: 'node "${PLUGIN_ROOT}\\scripts\\gate-guard.mjs"',
              timeout: 10,
            },
          ],
        },
      })
    );
    
    writeFileSync(join(scriptsDir, 'gate-guard.mjs'), '// gate-guard script\n');
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, true);
    assert.strictEqual(result.error, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - missing PreToolUse event returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PostToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/hooks/post-tool-use.mjs"',
              windows: 'node "${PLUGIN_ROOT}\\hooks\\post-tool-use.mjs"',
              timeout: 15,
            },
          ],
        },
      })
    );
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error?.includes('PreToolUse') || result.error?.includes('missing'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - PreToolUse empty returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [],
        },
      })
    );
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error?.includes('PreToolUse') || result.error?.includes('missing'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - no gate-guard script reference returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/hooks/post-tool-use.mjs"',
              windows: 'node "${PLUGIN_ROOT}\\hooks\\post-tool-use.mjs"',
              timeout: 10,
            },
          ],
        },
      })
    );
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error?.includes('gate-guard') || result.error?.includes('no PreToolUse entry'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - script file does not exist returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Note: not creating the scripts directory
    
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: 'node "${PLUGIN_ROOT}/scripts/gate-guard.mjs"',
              windows: 'node "${PLUGIN_ROOT}\\scripts\\gate-guard.mjs"',
              timeout: 10,
            },
          ],
        },
      })
    );
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error?.includes('not found') || result.error?.includes('gate-guard'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - corrupt hooks.json returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    const hooksDir = join(tempDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'hooks.json'), '{invalid json');
    
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error !== undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isGateGuardRegistered - missing hooks.json returns ok:false', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    // Don't create hooks.json
    const result = isGateGuardRegistered(tempDir);
    assert.equal(result.ok, false);
    assert(result.error !== undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
