// @ts-check
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { ensureDirSync, readTextFileSync, writeTextFileSync } from '../lib/fs-safe.mjs';
import { loadRegistry, validateRegistry, renderCapabilityTable } from '../lib/metadata/capability-registry.mjs';

/** @typedef {import('../lib/types.mjs').CapabilityRegistry} CapabilityRegistry */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** @param {string} relPath @returns {string} */
function rootPath(relPath) {
  return resolve(ROOT, relPath);
}

/**
 * Build the sentinel-wrapped generated block for a given section title and table.
 * @param {string} sectionId
 * @param {string} content
 * @returns {string}
 */
export function buildBlock(sectionId, content) {
  return `<!-- generated:${sectionId} -->\n${content}<!-- /generated:${sectionId} -->\n`;
}

/**
 * Replace or insert the sentinel-delimited block in `fileContent`.
 * Preserves manual content outside the markers.
 * @param {string} fileContent
 * @param {string} sectionId
 * @param {string} newContent  The new content to place BETWEEN the sentinels.
 * @returns {string}
 */
export function applySentinel(fileContent, sectionId, newContent) {
  const open = `<!-- generated:${sectionId} -->`;
  const close = `<!-- /generated:${sectionId} -->`;
  const block = `${open}\n${newContent}${close}\n`;
  const startIdx = fileContent.indexOf(open);
  const endIdx = fileContent.indexOf(close);
  if (startIdx !== -1 && endIdx !== -1) {
    return fileContent.slice(0, startIdx) + block + fileContent.slice(endIdx + close.length + 1);
  }
  // Append if not found
  return fileContent + '\n' + block;
}

/**
 * Read a file, returning empty string if missing.
 * @param {string} filePath
 * @returns {string}
 */
function readOrEmpty(filePath) {
  try {
    return readTextFileSync(filePath);
  } catch {
    return '';
  }
}

/**
 * Generate all docs sections from the registry and write them to target files.
 * @param {string[]} _args CLI args (without node/script).
 * @param {{ registryPath?: string, rootOverride?: string }} [opts]  Override for tests.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const registryPath = opts.registryPath ?? rootPath('docs/capability-registry.json');
  const root = opts.rootOverride ?? ROOT;

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
  const updates = [
    { file: p('README.md'), sectionId: 'capability-table', content: allTable },
    { file: p('docs/plugin-help.md'), sectionId: 'capability-table', content: allTable },
    { file: p('docs/marketplace.md'), sectionId: 'capability-summary', content: allTable },
    { file: p('docs/plugin-help.md'), sectionId: 'hook-table', content: hookTable },
    { file: p('docs/plugin-help.md'), sectionId: 'script-table', content: scriptTable },
  ];

  /** @type {string[]} */
  const written = [];

  for (const { file, sectionId, content } of updates) {
    const dir = dirname(file);
    ensureDirSync(dir);
    const existing = readOrEmpty(file);
    const updated = applySentinel(existing, sectionId, content);
    if (updated !== existing) {
      writeTextFileSync(file, updated);
      if (!written.includes(file)) written.push(file);
    }
  }

  if (written.length === 0) {
    process.stdout.write('generate-docs: all files already up to date.\n');
  } else {
    process.stdout.write(`generate-docs: wrote ${written.length} file(s):\n`);
    for (const f of written) {
      process.stdout.write(`  ${f}\n`);
    }
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
