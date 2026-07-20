// @ts-check
/**
 * E16-4: pure scorer for the security component eval. No I/O, no clock, no LLM
 * call — it grades a CAPTURED `security.json` artifact against a rubric fixture so
 * a security regression is attributable to this specialist alone (Huyen, AI
 * Engineering ch4, step 1). Mirrors the pure-scorer + committed-baseline split of
 * evals/gate-robustness and evals/skill-matching.
 *
 * The security artifact is `{ findings: SecurityFinding[], passed, unverified }`
 * (lib/workflow/agents/security.mjs); a finding is `{ severity, description,
 * path }` where `path` folds in the file+line (e.g. `sample/auth-guard.mjs#L42`).
 * The specialist is graded as a classifier — precision and recall against
 * fixtures with known vulnerabilities and known-clean paths:
 *   - recall     — of the rubric's knownVulns, how many did a finding flag?
 *   - precision  — of the findings on declared-clean paths, how many were false
 *                  positives? (A finding on a file that is neither a known vuln
 *                  nor a declared-clean path has no ground truth, so by default
 *                  it is neither credited nor penalized.)
 * score = F1(precision, recall); missing = missed known vulns (false negatives);
 * spurious = false-positive findings.
 *
 * Precision is gameable in the open-world default: a specialist could emit
 * findings on arbitrary undeclared files with no penalty. A rubric that declares
 * its FULL file universe can set `closedWorld: true` (#220) — then ANY finding
 * that flags no known vuln is a false positive, making precision non-gameable.
 * The default stays open-world so existing fixtures are unaffected.
 */

/**
 * @typedef {Object} SecurityRubric
 * @property {string[]} knownVulns         Evidence pointers a correct pass must flag.
 * @property {string[]} cleanPaths         Files with no vuln; a finding on one is a false positive.
 * @property {boolean} [closedWorld]       #220: when true, ANY finding not matching a known vuln is a false positive (the fixture declares its full file universe). Default open-world counts only findings on declared-clean paths.
 * @property {number} [passThreshold]      Suite gate; not read by the scorer.
 * @property {number} [expectedGoodScore]  Suite regression pin; not read by the scorer.
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
 * True when a finding flags a known vuln: exact pointer match when both carry a
 * line anchor, otherwise a same-file match.
 * @param {string} findingPath
 * @param {string} vuln
 * @returns {boolean}
 */
function flags(findingPath, vuln) {
  if (findingPath === vuln) return true;
  if (findingPath.includes('#') && vuln.includes('#')) return findingPath === vuln;
  return fileOf(findingPath) === fileOf(vuln);
}

/**
 * Score a security artifact against its rubric.
 * @param {{ findings?: Array<{ path?: string }> }} output  Parsed security.json.
 * @param {SecurityRubric} rubric
 * @returns {{ score: number, missing: string[], spurious: string[] }}
 */
export function scoreComponent(output, rubric) {
  const findings = Array.isArray(output && output.findings) ? output.findings : [];
  const findingPaths = findings
    .map((f) => (f && typeof f.path === 'string' ? f.path : ''))
    .filter((p) => p !== '');
  // Rubric arrays are committed fixtures, but stay total anyway: keep only
  // strings so a malformed entry can never reach `flags`/`fileOf` and throw.
  const knownVulns = (Array.isArray(rubric && rubric.knownVulns) ? rubric.knownVulns : []).filter(
    (v) => typeof v === 'string',
  );
  const cleanPaths = new Set(
    (Array.isArray(rubric && rubric.cleanPaths) ? rubric.cleanPaths : []).filter((p) => typeof p === 'string'),
  );

  // Recall: known vulns with no flagging finding are missing (false negatives).
  const missing = knownVulns.filter((v) => !findingPaths.some((p) => flags(p, v)));
  const truePositives = knownVulns.length - missing.length;
  const recall = knownVulns.length === 0 ? 1 : truePositives / knownVulns.length;

  // Precision: which findings are false positives?
  //   - open-world (default): only findings on a rubric-declared clean path — a
  //     finding on an undeclared file has no ground truth, so it is not counted.
  //   - closed-world (rubric.closedWorld === true): the fixture declares its FULL
  //     file universe, so ANY finding that flags no known vuln is a false
  //     positive — precision is then non-gameable (#220).
  // Strict opt-in: only the exact boolean `true` enables closed-world, so a
  // stray truthy value (e.g. a JSON string "false") can't silently flip the mode.
  const closedWorld = rubric != null && rubric.closedWorld === true;
  const spurious = closedWorld
    ? findingPaths.filter((p) => !knownVulns.some((v) => flags(p, v)))
    : findingPaths.filter((p) => cleanPaths.has(fileOf(p)));
  const falsePositives = spurious.length;
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);

  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { score: round4(f1), missing, spurious };
}
