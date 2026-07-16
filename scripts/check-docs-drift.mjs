// @ts-check
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { listDir, readTextFile } from '../lib/fs-safe.mjs';
import {
  buildGroundTruth,
  extractDocsClaims,
  diffClaims,
  extractEnforcementClaims,
  validateEnforcementClaims,
} from '../lib/docs-drift.mjs';

/** @typedef {import('../lib/types.mjs').DriftViolation} DriftViolation */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Read a text file, returning null when it does not exist. Other errors
 * are rethrown.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readTextOrNull(filePath) {
  try {
    return await readTextFile(filePath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Format violations as a compact, fixed-width table for the terminal.
 * @param {DriftViolation[]} violations
 * @returns {string}
 */
export function formatViolationTable(violations) {
  const header = '| File | Line | Type | Value | Reason |';
  const sep = '|---|---|---|---|---|';
  const rows = violations.map((v) => {
    const { file, line, claimType, value } = v.claim;
    return `| ${file} | ${line} | ${claimType} | ${value} | ${v.reason} |`;
  });
  return [header, sep, ...rows].join('\n');
}

/**
 * CI entrypoint: build ground truth, extract docs claims, diff, report drift.
 * Exits 0 when no drift, 1 when any docs claim does not match ground truth.
 * @param {string[]} _args  CLI args (without node/script).
 * @param {{
 *   rootOverride?: string,
 *   hooksPath?: string,
 *   configSchemaPath?: string,
 *   stateSchemaPath?: string,
 *   docsFiles?: string[],
 *   gateDocsFiles?: string[],
 *   patternsPath?: string,
 *   ciPath?: string,
 * }} [opts]  Overrides for tests.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;

  /** @param {string} rel @returns {string} */
  const p = (rel) => resolve(root, rel);

  const hooksPath = opts.hooksPath ?? p('hooks/hooks.json');
  const configSchemaPath = opts.configSchemaPath ?? p('docs/config-schema.json');
  // State schema is optional (E1 may not have landed); only pass if provided.
  const stateSchemaPath = opts.stateSchemaPath;

  /** @type {Parameters<typeof buildGroundTruth>[0]} */
  const sources = { hooksPath, configSchemaPath };
  if (stateSchemaPath !== undefined) sources.stateSchemaPath = stateSchemaPath;

  const groundTruth = await buildGroundTruth(sources);

  // Docs files that make explicit platform claims (full identifier scan:
  // hook events, config keys, counts, and gate names).
  const docsFiles = opts.docsFiles ?? [p('CHANGELOG.md'), p('docs/hooks.md')];

  // Prose-heavy sources scanned for gate-name claims only (E9-04): the
  // PascalCase/camelCase identifier heuristics would false-positive on the
  // typed contracts these files legitimately document.
  const gateDocsFiles =
    opts.gateDocsFiles ??
    [
      p('README.md'),
      p('docs/SCRIPTS.md'),
      p('docs/ARCHITECTURE.md'),
      p('docs/PATTERNS.md'),
      p('docs/SYSTEM_OVERVIEW.md'),
      p('docs/workflow.md'),
      p('docs/gate-guard.md'),
      ...(await listDir(resolve(root, 'agents')))
        .filter((f) => f.endsWith('.agent.md'))
        .map((f) => p(`agents/${f}`)),
    ];

  /** @type {import('../lib/types.mjs').DocsClaim[]} */
  const allClaims = [];
  for (const file of docsFiles) {
    const claims = await extractDocsClaims(file);
    allClaims.push(...claims);
  }
  for (const file of gateDocsFiles) {
    const claims = await extractDocsClaims(file, { claimTypes: ['gate-name'] });
    allClaims.push(...claims);
  }

  const violations = diffClaims(allClaims, groundTruth);

  // E9-30: PATTERNS.md enforcement-status honesty — vocabulary + file:line
  // pointer on every pattern, and a wiring cross-check for the
  // machine-checkable levels (ci-enforced against the CI workflow,
  // hook-runtime against the hook manifest). Absent sources skip the check
  // (mirrors buildGroundTruth's tolerance for test roots / pre-landing runs);
  // in the real repo all three files exist and the check always runs.
  const patternsPath = opts.patternsPath ?? p('docs/PATTERNS.md');
  const ciPath = opts.ciPath ?? p('.github/workflows/ci.yml');
  const [patternsText, ciText, hooksText] = await Promise.all([
    readTextOrNull(patternsPath),
    readTextOrNull(ciPath),
    readTextOrNull(hooksPath),
  ]);
  if (patternsText !== null && ciText !== null && hooksText !== null) {
    violations.push(
      ...validateEnforcementClaims(extractEnforcementClaims(patternsText), {
        ciText,
        hooksText,
        patternsFile: patternsPath,
      })
    );
  }

  if (violations.length === 0) {
    process.stdout.write('[check-docs-drift] PASS — docs match verified ground truth.\n');
    return 0;
  }

  process.stderr.write(
    `[check-docs-drift] FAIL — ${violations.length} drift violation(s):\n`
  );
  process.stderr.write(formatViolationTable(violations) + '\n');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
