// @ts-check
/**
 * E9-25: opt-in LLM-judge eval tier. Scores the two issue-quality dimensions
 * the structural code grader (`evals/issue-quality/scorer.mjs`) cannot
 * verify: whether cited claims are actually true (`claimsTrue`) and whether
 * acceptance criteria are genuinely testable (`acTestable`). The judge
 * complements the seven code-checked dimensions — it never replaces them.
 *
 * Off by default: without `DEVMATE_JUDGE=1` the script exits 0 doing
 * nothing, so `verify` and the required CI workflow are unaffected. The
 * separate non-required nightly workflow
 * (`.github/workflows/eval-nightly.yml`) opts in and uploads the artifact.
 *
 * A judge may answer null ("Unknown") on either dimension — an unavailable
 * judge reports honest nulls instead of inventing judgments.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { ensureDir, writeTextFile } from '../lib/fs-safe.mjs';
import { loadModelPolicy, routeModel } from '../lib/routing/model-policy.mjs';
import { POSITIVE_CASES } from '../evals/issue-quality/cases.mjs';

/** @typedef {import('../lib/types.mjs').JudgeVerdict} JudgeVerdict */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default artifact location (uploaded by the nightly workflow; gitignored). */
const DEFAULT_RESULTS_PATH = resolve(__dirname, '../evals/issue-quality/judge-latest.json');

/**
 * Resolve the judge model from the routing policy. Returns null when no
 * verified model is available — the judge then answers Unknown (null) for
 * every dimension instead of inventing judgments.
 * // TODO: judge model from verified policy (E9-11); do not hardcode an ID
 * @param {{ policyPath?: string }} [opts]
 * @returns {Promise<string|null>}
 */
async function resolveJudgeModel(opts = {}) {
  try {
    const policy = await loadModelPolicy({ policyPath: opts.policyPath });
    // Judgment is a quality-critical task: use the large-class entry, and
    // only when it is verified — routeModel throws on placeholders.
    const route = routeModel('large', policy);
    return route.modelId;
  } catch {
    return null;
  }
}

/**
 * Default judge client — honest about unavailability. No API client is wired
 * in this runtime (the plugin runs inside the Copilot host and CI has no
 * standing model budget), so without an injected judge every dimension is
 * null ("Unknown") with the reason in the rationale.
 * @param {{ id: string, body: string }} issueCase
 * @param {string|null} modelId
 * @returns {Promise<JudgeVerdict>}
 */
async function defaultJudge(issueCase, modelId) {
  const rationale =
    modelId === null
      ? 'Unknown: no verified judge model in config/model-policy.json (entries are placeholders); see docs/model-policy.md.'
      : `Unknown: judge model "${modelId}" is configured but no API client is wired in this runtime.`;
  return { issueId: issueCase.id, claimsTrue: null, acTestable: null, rationale };
}

/**
 * Run the opt-in judge tier over the issue-quality positive cases.
 * @param {string[]} args  Optional: [0] overrides the results output path.
 * @param {{ env?: Record<string, string|undefined>,
 *           judge?: typeof defaultJudge,
 *           cases?: Array<{ id: string, body: string }>,
 *           policyPath?: string }} [opts]  Injection seams for tests.
 * @returns {Promise<number>} exit code — 0 unless a verdict is explicitly
 *   false (nightly-only signal; this script never joins required CI).
 */
export async function main(args, opts = {}) {
  const env = opts.env ?? process.env;
  if (env.DEVMATE_JUDGE !== '1') {
    process.stdout.write('[eval-judge] DEVMATE_JUDGE not set — opt-in judge tier skipped.\n');
    return 0;
  }

  const resultsPath = args[0] ? resolve(args[0]) : DEFAULT_RESULTS_PATH;
  const cases = opts.cases ?? POSITIVE_CASES;
  const judge = opts.judge ?? defaultJudge;
  const modelId = await resolveJudgeModel({ policyPath: opts.policyPath });

  /** @type {JudgeVerdict[]} */
  const verdicts = [];
  for (const issueCase of cases) {
    verdicts.push(await judge(issueCase, modelId));
  }

  const unknown = verdicts.filter((v) => v.claimsTrue === null || v.acTestable === null).length;
  const failed = verdicts.filter((v) => v.claimsTrue === false || v.acTestable === false).length;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    judgeModel: modelId,
    judged: verdicts.length,
    unknown,
    failed,
    verdicts,
  };
  await ensureDir(dirname(resultsPath));
  await writeTextFile(resultsPath, JSON.stringify(summary, null, 2) + '\n');

  process.stdout.write(
    `[eval-judge] judged ${verdicts.length} issue(s) — ${failed} failed, ${unknown} unknown; ` +
      `results at ${resultsPath}\n`
  );
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
