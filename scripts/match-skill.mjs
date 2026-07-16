// @ts-check
import path from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { loadSkillManifests } from '../lib/skills/skill-manifest.mjs';
import { matchSkills } from '../lib/skills/semantic-matcher.mjs';

/**
 * E4-5: `match-skill` — agent-invoked semantic skill router CLI.
 *
 * Loads every SkillManifest under the skills root, scores them against the
 * query, and prints the ranked matches. No match is a valid result.
 *
 * Usage:
 *   node scripts/match-skill.mjs "<query>" [skillsRoot]
 *
 * Each result prints as: `[confidence] skillId — reason`.
 *
 * Exit: 0 always (no match is valid); 1 only when the query is missing.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const query = args[0];
  if (!query || query.trim() === '') {
    process.stderr.write('Usage: match-skill "[query]" [skillsRoot]\n');
    return 1;
  }
  const skillsRoot = args[1] || path.join(process.cwd(), 'skills');

  const manifests = await loadSkillManifests(skillsRoot);
  const results = matchSkills(query, manifests);

  if (results.length === 0) {
    process.stdout.write('No skills matched\n');
    return 0;
  }

  for (const r of results) {
    process.stdout.write(`[${r.confidence.toFixed(2)}] ${r.skillId} — ${r.reason}\n`);
  }
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
