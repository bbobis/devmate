// @ts-check
/**
 * E7-6: Pure scorer for generated GitHub issue bodies. No I/O — all file
 * reading happens in the entrypoint. Scores seven quality dimensions that
 * determine whether an LLM can implement the issue solo.
 */

/** @typedef {import('../../lib/types.mjs').IssueQualityScore} IssueQualityScore */

/**
 * Approved imperative verbs an issue title may start with (case-insensitive).
 * @type {string[]}
 */
export const IMPERATIVE_VERBS = [
  'Add', 'Build', 'Create', 'Define', 'Enforce',
  'Fix', 'Implement', 'Replace', 'Upgrade', 'Wire',
];

/**
 * Extract the title line: first H2 heading, else the first non-empty line.
 * @param {string} body
 * @returns {string}
 */
function extractTitle(body) {
  const lines = body.split('\n');
  const h2 = lines.find((l) => /^##\s+/.test(l));
  if (h2) return h2.replace(/^##\s+/, '').trim();
  const first = lines.find((l) => l.trim() !== '');
  return (first ?? '').trim();
}

/**
 * Return the text of a named `## Section` up to the next `## ` heading, or ''.
 * @param {string} body
 * @param {string} heading  Heading text (without the `## ` prefix).
 * @returns {string}
 */
function sectionText(body, heading) {
  const lines = body.split('\n');
  const needle = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => {
    const trimmed = l.trim();
    if (!trimmed.startsWith('##')) return false;
    const text = trimmed.slice(2).trim().toLowerCase();
    return text === needle;
  });
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Scores a raw GitHub issue body against the seven quality dimensions.
 * @param {string} issueId    Short identifier for reporting.
 * @param {string} issueBody  Raw markdown text of the issue.
 * @returns {IssueQualityScore}
 */
export function scoreIssueQuality(issueId, issueBody) {
  const body = issueBody ?? '';

  const title = extractTitle(body);
  const titleLower = title.toLowerCase();
  const titleImperative = IMPERATIVE_VERBS.some((v) => {
    const verb = v.toLowerCase();
    return titleLower === verb || titleLower.startsWith(`${verb} `);
  });

  // problemCited: search Background section (or whole body if absent).
  const background = sectionText(body, 'Background') || sectionText(body, 'Background & evidence') || body;
  const problemCited = /ws\d+-\w+\.md:\d+/.test(background) || /https:\/\//.test(background);

  // hasAcceptanceCriteria: >= 2 bullet items under the AC heading.
  const ac = sectionText(body, 'Acceptance criteria');
  const acBullets = ac.split('\n').filter((l) => /^-\s+\S/.test(l.trim()) || /^- /.test(l)).length;
  const hasAcceptanceCriteria = acBullets >= 2;

  // dependencyListed: Dependencies section contains 'None' or an issue number.
  const deps = sectionText(body, 'Dependencies');
  const dependencyListed = deps !== '' && (/\bNone\b/i.test(deps) || /#\d+/.test(deps));

  // tokenImpactStated: 'Token/context impact' label with a non-empty value.
  const tokenImpactStated = hasTokenImpact(body);

  // contractsInlined: if Dependencies lists any #N, an Upstream contracts section
  // with a fenced js block must exist. Trivially true when no #N dependency.
  const upstream = sectionText(body, 'Upstream contracts (inlined)');
  const hasJsBlock = /```js\b/.test(upstream);
  const depsHaveIssueRef = /#\d+/.test(deps);
  const contractsInlined = depsHaveIssueRef ? hasJsBlock : true;

  // externalClaimsSourced: any inlined-contracts section must carry a
  // `Source of truth: #N` provenance line. Trivially true when no section.
  const externalClaimsSourced =
    upstream === '' ? true : /Source of truth:\s*#\d+/.test(upstream);

  const score = [
    titleImperative,
    problemCited,
    hasAcceptanceCriteria,
    dependencyListed,
    tokenImpactStated,
    contractsInlined,
    externalClaimsSourced,
  ].filter(Boolean).length;

  return {
    issueId,
    titleImperative,
    problemCited,
    hasAcceptanceCriteria,
    dependencyListed,
    tokenImpactStated,
    contractsInlined,
    externalClaimsSourced,
    score,
  };
}

/**
 * True when 'Token/context impact' appears with a non-empty value on the same
 * line (after a colon) or on the next non-empty line.
 * @param {string} body
 * @returns {boolean}
 */
function hasTokenImpact(body) {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /token\/context impact/i.test(l));
  if (idx === -1) return false;
  const line = lines[idx];
  const afterColon = line.split(/token\/context impact\s*:?/i)[1] ?? '';
  if (afterColon.replace(/[*_`\s-]/g, '').length > 0) return true;
  const next = lines.slice(idx + 1).find((l) => l.trim() !== '');
  return next !== undefined && next.replace(/[*_`>\s-]/g, '').length > 0;
}
