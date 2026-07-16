// @ts-check

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { test } from 'node:test';
import { resolvePluginRoot } from '../../lib/plugin-root.mjs';

/**
 * Run `fn` with PLUGIN_ROOT set to `value` (or unset when null), restoring the
 * previous value afterwards.
 * @param {string|null} value
 * @param {() => void} fn
 * @returns {void}
 */
function withPluginRootEnv(value, fn) {
  const previous = process.env['PLUGIN_ROOT'];
  try {
    if (value === null) delete process.env['PLUGIN_ROOT'];
    else process.env['PLUGIN_ROOT'] = value;
    fn();
  } finally {
    if (previous === undefined) delete process.env['PLUGIN_ROOT'];
    else process.env['PLUGIN_ROOT'] = previous;
  }
}

test('resolvePluginRoot - falls back to the module-derived plugin root', () => {
  withPluginRootEnv(null, () => {
    const root = resolvePluginRoot();
    assert.ok(isAbsolute(root), `expected an absolute path, got ${root}`);
    // The plugin root is the dir that ships the plugin's artifacts.
    assert.ok(existsSync(join(root, 'hooks', 'hooks.json')), 'hooks/hooks.json must resolve');
    assert.ok(existsSync(join(root, 'scripts', 'gate-guard.mjs')), 'gate-guard must resolve');
    assert.ok(existsSync(join(root, '.plugin', 'plugin.json')), 'plugin manifest must resolve');
  });
});

test('resolvePluginRoot - prefers PLUGIN_ROOT when the host exports it', () => {
  const target = resolve('/tmp/some-plugin-install');
  withPluginRootEnv(target, () => {
    assert.equal(resolvePluginRoot(), target);
  });
});

test('resolvePluginRoot - ignores an empty PLUGIN_ROOT', () => {
  withPluginRootEnv('', () => {
    const root = resolvePluginRoot();
    assert.ok(existsSync(join(root, 'hooks', 'hooks.json')), 'must fall back, not return ""');
  });
});
