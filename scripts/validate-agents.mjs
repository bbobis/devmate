// @ts-check
import { basename, join, resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { listDirSync, readTextFileSync, statPathSync } from '../lib/fs-safe.mjs';
import { parseAgentFrontmatter, validateAgent } from '../lib/agent-validator.mjs';
import { loadModelCatalog, checkModelRule } from '../lib/model-catalog.mjs';

/**
 * Recursively glob for files matching a suffix under a directory.
 * @param {string} dir
 * @param {string} suffix
 * @returns {string[]}
 */
function globFiles(dir, suffix) {
  /** @type {string[]} */
  const results = [];
  let entries;
  try {
    entries = listDirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statPathSync(full); } catch { continue; }
    if (st.isDirectory()) {
      results.push(...globFiles(full, suffix));
    } else if (entry.endsWith(suffix)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * CI entrypoint: scan for *.agent.md files, validate each, print compact report, exit 1 on violations.
 * Accepts optional --dir <path> to restrict the scan root.
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  let scanRoot = resolve('.');
  const dirIdx = args.indexOf('--dir');
  const dirVal = args.at(dirIdx + 1);
  if (dirIdx !== -1 && dirVal) {
    scanRoot = resolve(dirVal);
  }

  const agentFiles = globFiles(scanRoot, '.agent.md');

  if (agentFiles.length === 0) {
    process.stdout.write('[validate-agents] No *.agent.md files found. Nothing to validate.\n');
    return 0;
  }

  /** @type {import('../lib/agent-validator.mjs').AgentValidationResult[]} */
  const results = await Promise.all(agentFiles.map((f) => validateAgent(f)));

  /** @type {Map<string, import('../lib/agent-validator.mjs').AgentValidationResult>} */
  const resultByPath = new Map(results.map((r) => [r.filePath, r]));
  const knownAgentNames = new Set(agentFiles.map((f) => basename(f, '.agent.md')));

  const catalogIdx = args.indexOf('--catalog');
  const catalogVal = args.at(catalogIdx + 1);
  const catalog = loadModelCatalog(
    catalogIdx !== -1 && catalogVal ? { catalogPath: resolve(catalogVal) } : {}
  );

  for (const filePath of agentFiles) {
    const frontmatter = parseAgentFrontmatter(readTextFileSync(filePath));
    const result = resultByPath.get(filePath);
    if (!result) continue;

    for (const agentName of frontmatter.agents ?? []) {
      if (knownAgentNames.has(agentName)) continue;
      result.violations.push({
        claim: { type: 'read-only', line: 1, excerpt: 'agents frontmatter' },
        requiredTool: 'agent-file-exists',
        message: `Frontmatter 'agents' lists '${agentName}' but no '${agentName}.agent.md' exists in scan root.`,
      });
    }

    // The `model:` field is read by the VS Code host, not by devmate, so an
    // unresolvable value degrades silently to the model picker instead of
    // erroring. CI is the only place it can be caught.
    for (const v of checkModelRule(frontmatter, basename(filePath, '.agent.md'), catalog)) {
      result.violations.push({
        claim: { type: 'read-only', line: 1, excerpt: 'model frontmatter' },
        requiredTool: 'model-in-catalog',
        message: v.message,
      });
    }

    result.ok = result.violations.length === 0;
  }

  const failing = results.filter((r) => !r.ok);

  if (failing.length === 0) {
    process.stdout.write(`[validate-agents] PASS — all ${agentFiles.length} agent(s) are consistent.\n`);
    return 0;
  }

  process.stderr.write(`[validate-agents] FAIL — ${failing.length} agent(s) have validation violations:\n\n`);
  for (const r of failing) {
    process.stderr.write(`  File: ${r.filePath}\n`);
    for (const v of r.violations) {
      process.stderr.write(`    ${v.message}\n`);
    }
    process.stderr.write('\n');
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
