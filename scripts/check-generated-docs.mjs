// @ts-check
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { loadRegistry, validateRegistry, renderCapabilityTable } from '../lib/metadata/capability-registry.mjs';
import { applySentinel } from './generate-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Extract the content between sentinel markers (exclusive of the markers themselves).
 * Returns null if the sentinel is not found.
 * @param {string} fileContent
 * @param {string} sectionId
 * @returns {string|null}
 */
export function extractSentinelBlock(fileContent, sectionId) {
  const open = `<!-- generated:${sectionId} -->`;
  const close = `<!-- /generated:${sectionId} -->`;
  const startIdx = fileContent.indexOf(open);
  const endIdx = fileContent.indexOf(close);
  if (startIdx === -1 || endIdx === -1) return null;
  return fileContent.slice(startIdx + open.length + 1, endIdx);
}

/**
 * Check that all generated sentinel blocks are up to date.
 * @param {string[]} _args
 * @param {{ registryPath?: string, rootOverride?: string }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;
  const registryPath = opts.registryPath ?? resolve(root, 'docs/capability-registry.json');

  /** @param {string} rel @returns {string} */
  const p = (rel) => resolve(root, rel);

  const registry = loadRegistry(registryPath);
  const validation = validateRegistry(registry);
  if (!validation.ok) {
    process.stderr.write(`Registry validation failed:\n${validation.errors.join('\n')}\n`);
    return 1;
  }

  const allTable = renderCapabilityTable(registry.capabilities);
  const hookTable = renderCapabilityTable(registry.capabilities, 'hook');
  const scriptTable = renderCapabilityTable(registry.capabilities, 'script');

  /** @type {Array<{ file: string, sectionId: string, content: string }>} */
  const checks = [
    { file: p('README.md'), sectionId: 'capability-table', content: allTable },
    { file: p('docs/plugin-help.md'), sectionId: 'capability-table', content: allTable },
    { file: p('docs/marketplace.md'), sectionId: 'capability-summary', content: allTable },
    { file: p('docs/plugin-help.md'), sectionId: 'hook-table', content: hookTable },
    { file: p('docs/plugin-help.md'), sectionId: 'script-table', content: scriptTable },
  ];

  /** @type {string[]} */
  const stale = [];

  for (const { file, sectionId, content } of checks) {
    let existing;
    try {
      existing = readTextFileSync(file);
    } catch {
      stale.push(`${file} [${sectionId}] — file missing`);
      continue;
    }
    // Regenerate in memory to compare
    const expected = applySentinel(existing, sectionId, content);
    if (expected !== existing) {
      stale.push(`${file} [${sectionId}]`);
    }
  }

  if (stale.length === 0) {
    process.stdout.write('check-generated-docs: all generated sections are up to date.\n');
    return 0;
  }

  process.stderr.write(`check-generated-docs: STALE — run \`node scripts/generate-docs.mjs\` to fix:\n`);
  for (const s of stale) {
    process.stderr.write(`  ${s}\n`);
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
