// @ts-check
/**
 * E16-4: pure scorer for the discovery component eval. No I/O, no clock, no LLM
 * call — it grades a CAPTURED `discovery.json` artifact against a rubric fixture,
 * so a discovery regression is attributable to this specialist alone (Huyen, AI
 * Engineering ch4, step 1: evaluate each component in isolation). Mirrors the
 * pure-scorer + committed-baseline split of evals/gate-robustness and
 * evals/skill-matching.
 *
 * The discovery artifact is `{ claims: DiscoveryClaim[], unverified: string[] }`
 * (lib/workflow/agents/discovery.mjs) — a claim is `{ fact, path, confidence }`,
 * NOT an evidence-pack EvidencePointer. Two dimensions are graded:
 *   - coverage      — did the pass surface every pointer the rubric requires?
 *   - groundedness  — does every claim resolve to a real file? The rubric
 *                     declares the grounded (existing) paths so the scorer stays
 *                     I/O-free; a claim whose file is not among them is spurious.
 * score = coverage * groundedness, so either a missed required pointer or an
 * ungrounded claim pulls the score down.
 */

/**
 * @typedef {Object} DiscoveryRubric
 * @property {string[]} requiredPointers  Evidence pointers a correct pass must surface.
 * @property {string[]} groundedPaths     File paths (no line anchor) that exist.
 * @property {number} [passThreshold]     Suite gate; not read by the scorer.
 * @property {number} [expectedGoodScore] Suite regression pin; not read by the scorer.
 */

/**
 * The file portion of an evidence pointer (drop any `#L…` line anchor).
 * @param {string} pointer
 * @returns {string}
 */
function fileOf(pointer) {
  const raw = typeof pointer === 'string' ? pointer : '';
  const at = raw.indexOf('#');
  return at === -1 ? raw : raw.slice(0, at);
}

/**
 * Round to 4dp — repo house style; keeps float noise from flapping the CI gate.
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * True when a claim covers a required pointer: an exact match, or — when the
 * requirement names only a file (no line anchor) — a same-file claim.
 * @param {string} claimPath
 * @param {string} required
 * @returns {boolean}
 */
function covers(claimPath, required) {
  if (claimPath === required) return true;
  if (!required.includes('#')) return fileOf(claimPath) === required;
  return false;
}

/**
 * Score a discovery artifact against its rubric.
 * @param {{ claims?: Array<{ path?: string }> }} output  Parsed discovery.json.
 * @param {DiscoveryRubric} rubric
 * @returns {{ score: number, missing: string[], spurious: string[] }}
 */
export function scoreComponent(output, rubric) {
  const claims = Array.isArray(output && output.claims) ? output.claims : [];
  const claimPaths = claims
    .map((c) => (c && typeof c.path === 'string' ? c.path : ''))
    .filter((p) => p !== '');
  // Rubric arrays are committed fixtures, but stay total anyway: keep only
  // strings so a malformed entry can never reach `covers`/`fileOf` and throw.
  const required = (Array.isArray(rubric && rubric.requiredPointers) ? rubric.requiredPointers : []).filter(
    (p) => typeof p === 'string',
  );
  const grounded = new Set(
    (Array.isArray(rubric && rubric.groundedPaths) ? rubric.groundedPaths : []).filter((p) => typeof p === 'string'),
  );

  // Coverage: required pointers with no covering claim are missing.
  const missing = required.filter((req) => !claimPaths.some((p) => covers(p, req)));
  const coverage = required.length === 0 ? 1 : (required.length - missing.length) / required.length;

  // Groundedness: claims whose file is not a known-existing path are spurious.
  const spurious = claimPaths.filter((p) => !grounded.has(fileOf(p)));
  const groundedness = claimPaths.length === 0 ? 1 : (claimPaths.length - spurious.length) / claimPaths.length;

  return { score: round4(coverage * groundedness), missing, spurious };
}
