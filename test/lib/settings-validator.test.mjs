// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadKnownSettings, extractSettingKeys, validateSettingKeys } from '../../lib/settings-validator.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `settings-validator-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadKnownSettings
// ---------------------------------------------------------------------------
describe('loadKnownSettings', () => {
  it('parses a valid verified-settings.json and returns the correct entry count', () => {
    const p = join(fixtureDir, 'valid-allowlist.json');
    /** @type {import('../../lib/settings-validator.mjs').VerifiedSetting[]} */
    const entries = [
      { key: 'github.copilot.enable', evidenceUrl: 'https://example.com/1', description: 'Inline suggestions.' },
      { key: 'chat.agent.enabled', evidenceUrl: 'https://example.com/2', description: 'Agent mode.' },
    ];
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, evidenceUrl: 'https://example.com', settings: entries }));
    const result = loadKnownSettings(p);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 'github.copilot.enable');
  });

  it('throws on malformed JSON without overwriting the file', () => {
    const p = join(fixtureDir, 'malformed-allowlist.json');
    const originalContent = '{ NOT VALID JSON }';
    writeFileSync(p, originalContent);
    assert.throws(
      () => loadKnownSettings(p),
      (/** @type {Error} */ err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('malformed JSON') ||
          err.message.includes('cannot parse') ||
          err.message.includes('JSON'),
        );
        return true;
      },
    );
    // File must not be overwritten
    assert.equal(readFileSync(p, 'utf8'), originalContent);
  });
});

// ---------------------------------------------------------------------------
// extractSettingKeys
// ---------------------------------------------------------------------------
describe('extractSettingKeys', () => {
  it('extracts nested dot-joined keys from a fixture JSON settings file', async () => {
    const p = join(fixtureDir, 'settings-flat.json');
    // VS Code settings.json uses dotted top-level keys (already dot-joined)
    writeFileSync(p, JSON.stringify({
      'github.copilot.enable': { '*': true },
      'chat.agent.enabled': true,
    }));
    const keys = await extractSettingKeys(p);
    assert.ok(keys.includes('github.copilot.enable'), 'should include github.copilot.enable');
    assert.ok(keys.includes('chat.agent.enabled'), 'should include chat.agent.enabled');
  });

  it('strips // comments from a JSONC fixture before extracting keys', async () => {
    const p = join(fixtureDir, 'settings.jsonc');
    writeFileSync(
      p,
      '// This is a JSONC comment\n' +
      '{\n' +
      '  // Inline suggestion key\n' +
      '  "github.copilot.enable": true,\n' +
      '  "chat.agent.enabled": false\n' +
      '}\n',
    );
    const keys = await extractSettingKeys(p);
    assert.ok(keys.includes('github.copilot.enable'), 'should include github.copilot.enable');
    assert.ok(keys.includes('chat.agent.enabled'), 'should include chat.agent.enabled');
  });

  it('returns an empty array for an empty settings object', async () => {
    const p = join(fixtureDir, 'settings-empty.json');
    writeFileSync(p, '{}');
    const keys = await extractSettingKeys(p);
    assert.deepEqual(keys, []);
  });
});

// ---------------------------------------------------------------------------
// validateSettingKeys
// ---------------------------------------------------------------------------
describe('validateSettingKeys', () => {
  /** @type {import('../../lib/settings-validator.mjs').VerifiedSetting[]} */
  const knownSettings = [
    { key: 'github.copilot.enable', evidenceUrl: 'https://example.com/1' },
    { key: 'chat.agent.enabled', evidenceUrl: 'https://example.com/2' },
  ];

  it('returns {ok:true} when all keys are in the known set', () => {
    const result = validateSettingKeys(['github.copilot.enable', 'chat.agent.enabled'], knownSettings);
    assert.equal(result.ok, true);
    assert.deepEqual(result.unknownKeys, []);
  });

  it('returns {ok:false} with the correct unknownKeys array when one key is absent', () => {
    const result = validateSettingKeys(['github.copilot.enable', 'some.unknown.key'], knownSettings);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknownKeys, ['some.unknown.key']);
  });

  it('a key present in the known set does not appear in unknownKeys', () => {
    const result = validateSettingKeys(['github.copilot.enable', 'bad.key'], knownSettings);
    assert.ok(!result.unknownKeys.includes('github.copilot.enable'));
    assert.ok(result.unknownKeys.includes('bad.key'));
  });
});

// ---------------------------------------------------------------------------
// Default-path branch (issue #50 regression): with no override arg the lib
// must locate the repo's real docs/verified-settings.json from its own module
// URL. Broken on Windows when derived via URL.pathname (/C:/... paths);
// every other test passes an override, so only this exercises it.
// ---------------------------------------------------------------------------
describe('default path resolution (no overrides)', () => {
  it('loadKnownSettings() loads the repo allowlist from the module-relative default', () => {
    const settings = loadKnownSettings();
    assert.ok(Array.isArray(settings));
    assert.ok(settings.length > 0, 'expected the real repo verified-settings to have entries');
    assert.equal(typeof settings[0].key, 'string');
  });
});
