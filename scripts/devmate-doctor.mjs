// @ts-check
// Agent-invoked entrypoint: health-check the three-stage memory pipeline
// (task ledgers → repo ledger → .devmate/MEMORY.md) and report the first broken stage.
// Also runs DN-1 business-domain doctor checks (declared-but-missing
// contextFile, dangling relatedDomains id, missing entryPoints path) when
// the repo's devmate.config.json declares a `domains` array — warnings only,
// never affecting this command's exit code.
// Prints a compact JSON summary to stdout and human-readable findings to
// stderr; writes the full diagnosis to .devmate/state/memory-doctor-result.json
// for read_file access. Never prints ledger contents.
import { resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { diagnoseMemory } from '../lib/memory/doctor.mjs';
import { checkDomainConfig } from '../lib/config/domain-doctor.mjs';
import { loadDevmateConfig, CONFIG_PATH } from '../lib/config/devmate-config.mjs';
import { writeResult } from '../lib/output/write-result.mjs';

/**
 * Parse `--key value` / `--key=value` args into a flat map.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = args.at(i + 1);
      if (next !== undefined && !next.startsWith('--')) {
        out.set(a.slice(2), next);
        i += 1;
      } else {
        out.set(a.slice(2), 'true');
      }
    }
  }
  return out;
}

/**
 * Entrypoint. `--root <dir>` defaults to cwd.
 *
 * Exit: 0 when the pipeline looks healthy, 1 when a stage looks broken.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  const root = resolve(args.get('root') ?? process.cwd());

  const diagnosis = await diagnoseMemory(root);

  // DN-1: domain doctor checks are best-effort — a missing/invalid config is
  // not this command's concern (the loader and gate-guard already surface
  // that); skip domain checks silently rather than failing the whole run.
  const configResult = loadDevmateConfig(resolve(root, CONFIG_PATH));
  const domainWarnings = configResult.ok
    ? checkDomainConfig(root, configResult.config.domains ?? [])
    : [];

  await writeResult(
    resolve(root, '.devmate/state/memory-doctor-result.json'),
    { ...diagnosis, domainWarnings },
  );

  // Compact machine-readable summary on stdout (never ledger contents).
  process.stdout.write(
    `${JSON.stringify({
      ok: diagnosis.ok,
      firstBrokenStage: diagnosis.firstBrokenStage,
      collection: diagnosis.collection,
      promotion: diagnosis.promotion,
      render: diagnosis.render,
      domainWarnings,
    })}\n`,
  );

  // Human-readable findings on stderr.
  for (const finding of diagnosis.findings) {
    process.stderr.write(`[memory-doctor] ${finding}\n`);
  }
  for (const warning of domainWarnings) {
    process.stderr.write(`[devmate-doctor] WARNING: ${warning}\n`);
  }

  return diagnosis.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
