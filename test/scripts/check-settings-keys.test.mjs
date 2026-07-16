// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-settings-keys.mjs';

/** @type {string} */
let fixtureDir;

/**
 * Build a minimal fixture: an allowlist JSON and a settings JSON file.
 * @param {string} baseDir
 * @param {Array<{key: string, evidenceUrl: string}>} allowlistEntries
 * @param {Record<string, unknown>} settingsContent
 * @param {string} [settingsRelPath]
 * @returns {{ allowlistPath: string, settingsPath: string }}
 */
function buildFixture(baseDir, allowlistEntries, settingsContent, settingsRelPath = '.vscode/settings.json') {
  mkdirSync(baseDir, { recursive: true });
  const allowlistPath = join(baseDir, 'allowlist.json');
  writeFileSync(
    allowlistPath,
    JSON.stringify({ schemaVersion: 1, evidenceUrl: 'https://example.com', settings: allowlistEntries }),
  );
  const settingsPath = join(baseDir, settingsRelPath);
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settingsContent));
  return { allowlistPath, settingsPath };
}

before(() => {
  fixtureDir = join(tmpdir(), `check-settings-keys-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('check-settings-keys main()', () => {
  it('returns 0 for a fixture settings file whose keys are all verified', async () => {
    const dir = join(fixtureDir, 'clean');
    const entries = [
      { key: 'github.copilot.enable', evidenceUrl: 'https://example.com/1' },
      { key: 'chat.agent.enabled', evidenceUrl: 'https://example.com/2' },
    ];
    const { allowlistPath, settingsPath } = buildFixture(
      dir, entries, { 'github.copilot.enable': true, 'chat.agent.enabled': true },
    );
    const code = await main(['--files', settingsPath], allowlistPath, dir);
    assert.equal(code, 0);
  });

  it('returns 1 and prints the unknown key and file name for a fixture with one unverified key', async () => {
    const dir = join(fixtureDir, 'violation');
    const entries = [
      { key: 'github.copilot.enable', evidenceUrl: 'https://example.com/1' },
    ];
    const { allowlistPath, settingsPath } = buildFixture(
      dir, entries,
      { 'github.copilot.enable': true, 'some.totally.unknown.key': false },
    );
    // Capture stdout to verify the unknown key is printed
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ s) => { captured += s; return true; }
    );
    const code = await main(['--files', settingsPath], allowlistPath, dir);
    process.stdout.write = originalWrite;
    assert.equal(code, 1);
    assert.ok(captured.includes('some.totally.unknown.key'), `Expected unknown key in output. Got: ${captured}`);
  });

  it('--files flag restricts scanning to the specified file path', async () => {
    const dir = join(fixtureDir, 'flag-files');
    const entries = [
      { key: 'github.copilot.enable', evidenceUrl: 'https://example.com/1' },
    ];
    // Create a clean settings file and a separate dirty one
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    mkdirSync(join(dir, 'extra'), { recursive: true });
    const allowlistPath = join(dir, 'allowlist.json');
    writeFileSync(
      allowlistPath,
      JSON.stringify({ schemaVersion: 1, evidenceUrl: 'https://example.com', settings: entries }),
    );
    // Clean file: only verified key
    const cleanPath = join(dir, '.vscode', 'settings.json');
    writeFileSync(cleanPath, JSON.stringify({ 'github.copilot.enable': true }));
    // Dirty file: has an unknown key
    const dirtyPath = join(dir, 'extra', 'settings.json');
    writeFileSync(dirtyPath, JSON.stringify({ 'bad.unverified.key': true }));

    // Only scan the clean file via --files
    const code = await main(['--files', cleanPath], allowlistPath, dir);
    assert.equal(code, 0, 'Expected 0 because only the clean file was scanned');
  });
});
