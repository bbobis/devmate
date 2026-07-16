// @ts-check
import path from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import {
  TRIGGER_LINE_BUDGET,
  loadSkillManifests,
  validateSkillSplit,
} from '../lib/skills/skill-manifest.mjs';

/**
 * CI entrypoint: load all skill manifests under the skills root and fail if any
 * trigger stub exceeds the line budget.
 * @param {string[]} args  argv slice; args[0] optional skills root.
 * @returns {Promise<number>}  Process exit code (0 = pass, 1 = violations).
 */
export async function main(args) {
  const skillsDir = args[0]
    ? path.resolve(args[0])
    : path.join(process.cwd(), 'skills');

  const manifests = await loadSkillManifests(skillsDir);

  if (manifests.length === 0) {
    process.stdout.write(`No skills found under ${skillsDir}\n`);
    return 0;
  }

  const result = validateSkillSplit(manifests);
  const overById = new Map(result.violations.map((v) => [v.skillId, v]));

  for (const m of manifests) {
    const over = overById.get(m.skillId);
    if (over) {
      process.stdout.write(
        `FAIL ${m.skillId}: ${over.lineCount} lines (budget ${over.budget})\n`,
      );
    } else {
      process.stdout.write(
        `PASS ${m.skillId}: ${m.triggerLineCount} lines (budget ${TRIGGER_LINE_BUDGET})\n`,
      );
    }
  }

  if (!result.ok) {
    process.stdout.write(
      `\n${result.violations.length} skill(s) over the ${TRIGGER_LINE_BUDGET}-line trigger budget.\n`,
    );
    return 1;
  }

  process.stdout.write(`\nAll ${manifests.length} skill(s) within budget.\n`);
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
