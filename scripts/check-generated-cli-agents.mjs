// @ts-check
/**
 * Fail when committed `.github/agents/*.md` files have drifted from their
 * Chat sources (`agents/*.agent.md`). Mirrors the check-generated-docs pattern.
 *
 * Exit 0 = up to date, 1 = stale or missing.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { parseAgentFile, renderCliAgent, DEFAULT_AGENTS } from './generate-cli-agents.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Regenerate every CLI agent in memory and compare to the committed file.
 * @param {string[]} _args
 * @param {{ agents?: Array<{ source: string, target: string }>, rootOverride?: string }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;
  const agents = opts.agents ?? DEFAULT_AGENTS;

  /** @param {string} rel @returns {string} */
  const p = (rel) => resolve(root, rel);

  /** @type {string[]} */
  const stale = [];
  for (const { source, target } of agents) {
    const parsed = parseAgentFile(readTextFileSync(p(source)));
    if (!parsed) {
      stale.push(`${target} — could not parse source ${source}`);
      continue;
    }
    const expected = renderCliAgent(parsed.frontmatter, parsed.body, source);
    let committed = '';
    try {
      committed = readTextFileSync(p(target));
    } catch {
      stale.push(`${target} — file missing (run: node scripts/generate-cli-agents.mjs)`);
      continue;
    }
    if (expected !== committed) {
      stale.push(`${target} — stale (run: node scripts/generate-cli-agents.mjs)`);
    }
  }

  if (stale.length === 0) {
    process.stdout.write('check-generated-cli-agents: all CLI agents up to date.\n');
    return 0;
  }
  process.stderr.write('check-generated-cli-agents: drift detected:\n');
  for (const s of stale) process.stderr.write(`  ${s}\n`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion();
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
