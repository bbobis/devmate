// @ts-check
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { ensureDirSync, readTextFileSync, writeTextFileSync } from '../lib/fs-safe.mjs';
import { loadRegistry, validateRegistry } from '../lib/metadata/capability-registry.mjs';

/** @typedef {import('../lib/types.mjs').CapabilityEntry} CapabilityEntry */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Sentinel marking the start of generated content; nothing manual goes inside. */
export const GENERATION_SENTINEL =
  '<!-- generated:current-behavior — DO NOT EDIT BY HAND. Run scripts/generate-current-behavior.mjs -->';
const GENERATION_SENTINEL_CLOSE = '<!-- /generated:current-behavior -->';

/**
 * Read and JSON-parse a file, returning null when it does not exist.
 * @param {string} filePath
 * @returns {unknown|null}
 */
function readJsonOrNull(filePath) {
  let raw;
  try {
    raw = readTextFileSync(filePath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Parse a node:test JSON-reporter summary into pass/fail/total counts.
 * Returns null when the file is absent or has no usable summary.
 * @param {string} testSummaryPath
 * @returns {{ tests: number, pass: number, fail: number }|null}
 */
function readTestSummary(testSummaryPath) {
  const data = readJsonOrNull(testSummaryPath);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const tests = typeof d['tests'] === 'number' ? d['tests'] : undefined;
  const pass = typeof d['pass'] === 'number' ? d['pass'] : undefined;
  const fail = typeof d['fail'] === 'number' ? d['fail'] : undefined;
  if (tests === undefined || pass === undefined || fail === undefined) return null;
  return { tests, pass, fail };
}

/**
 * Build the verified hook-events section from the hooks manifest.
 * Only event names actually present in the manifest are listed.
 * @param {unknown} manifest
 * @returns {string}
 */
function renderHookEvents(manifest) {
  /** @type {string[]} */
  const events = [];
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const hooks = /** @type {Record<string, unknown>} */ (manifest)['hooks'];
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
      events.push(...Object.keys(/** @type {Record<string, unknown>} */ (hooks)));
    }
  }
  const lines = ['### Verified Hook Events', ''];
  if (events.length === 0) {
    lines.push('_No hook events registered._');
  } else {
    for (const e of events) lines.push(`- \`${e}\``);
  }
  return lines.join('\n');
}

/**
 * Build the verified config-keys section from a config schema.
 * Skipped (with a note) when no schema file is present, so we never assert
 * config keys that are not backed by a verified schema.
 * @param {unknown} configSchema
 * @returns {string}
 */
function renderConfigKeys(configSchema) {
  /** @type {string[]} */
  const keys = [];
  if (configSchema !== null && typeof configSchema === 'object' && !Array.isArray(configSchema)) {
    const props = /** @type {Record<string, unknown>} */ (configSchema)['properties'];
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      keys.push(...Object.keys(/** @type {Record<string, unknown>} */ (props)));
    }
  }
  const lines = ['### Verified Config Keys', ''];
  if (keys.length === 0) {
    lines.push('_No verified config schema present yet._');
  } else {
    for (const k of keys) lines.push(`- \`${k}\``);
  }
  return lines.join('\n');
}

/**
 * Build the registered-scripts section from the capability registry.
 * @param {CapabilityEntry[]} capabilities
 * @returns {string}
 */
function renderScripts(capabilities) {
  const scripts = capabilities.filter((c) => c.type === 'script');
  const lines = ['### Registered Scripts', ''];
  if (scripts.length === 0) {
    lines.push('_No scripts registered._');
  } else {
    lines.push(`- ${scripts.length} scripts registered.`, '');
    for (const s of scripts) lines.push(`- \`${s.invocationPath}\` — ${s.description}`);
  }
  return lines.join('\n');
}

/**
 * Build the test pass/fail summary section.
 * @param {{ tests: number, pass: number, fail: number }|null} summary
 * @returns {string}
 */
function renderTestSummary(summary) {
  const lines = ['### Test Pass/Fail Summary', ''];
  if (summary === null) {
    lines.push('_No machine-readable test summary available at generation time._');
  } else {
    lines.push(
      `- tests: ${summary.tests}`,
      `- pass: ${summary.pass}`,
      `- fail: ${summary.fail}`
    );
  }
  return lines.join('\n');
}

/**
 * CI entrypoint: generate docs/CURRENT_BEHAVIOR.md from verified metadata.
 * Only behavior backed by the registry, the hooks manifest, a config schema,
 * or a passing test summary is included — never unverified claims.
 * @param {string[]} _args  CLI args (without node/script).
 * @param {{
 *   rootOverride?: string,
 *   registryPath?: string,
 *   hooksPath?: string,
 *   configSchemaPath?: string,
 *   testSummaryPath?: string,
 *   outputPath?: string,
 * }} [opts]  Overrides for tests.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;

  /** @param {string} rel @returns {string} */
  const p = (rel) => resolve(root, rel);

  const registryPath = opts.registryPath ?? p('docs/capability-registry.json');
  const hooksPath = opts.hooksPath ?? p('hooks/hooks.json');
  const configSchemaPath = opts.configSchemaPath ?? p('docs/config-schema.json');
  const testSummaryPath = opts.testSummaryPath ?? p('docs/.test-summary.json');
  const outputPath = opts.outputPath ?? p('docs/CURRENT_BEHAVIOR.md');

  const registry = loadRegistry(registryPath);
  const validation = validateRegistry(registry);
  if (!validation.ok) {
    process.stderr.write(`Registry validation failed:\n${validation.errors.join('\n')}\n`);
    return 1;
  }

  const manifest = readJsonOrNull(hooksPath);
  const configSchema = readJsonOrNull(configSchemaPath);
  const testSummary = readTestSummary(testSummaryPath);

  const body = [
    '# Current Behavior (devmate)',
    '',
    GENERATION_SENTINEL,
    '',
    'This file is generated from the capability registry, the hooks manifest,',
    'and the test suite. It lists ONLY verified behavior. Do not add unverified',
    'claims here — add them to `CHANGELOG.md` with a historical marker instead.',
    '',
    renderHookEvents(manifest),
    '',
    renderConfigKeys(configSchema),
    '',
    renderScripts(registry.capabilities),
    '',
    renderTestSummary(testSummary),
    '',
    GENERATION_SENTINEL_CLOSE,
    '',
  ].join('\n');

  ensureDirSync(dirname(outputPath));
  writeTextFileSync(outputPath, body);
  process.stdout.write(`[generate-current-behavior] wrote ${outputPath}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
