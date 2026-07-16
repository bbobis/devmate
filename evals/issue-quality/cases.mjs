// @ts-check
/**
 * E7-6 / E8 (#81): Positive issue-quality eval cases. Each is a well-formed
 * issue body that satisfies all seven quality dimensions and must score 7/7.
 *
 * These fixtures mirror the gold-standard structure devmate emits (imperative
 * title, cited background, >=2 AC bullets, dependency list, token impact, and an
 * inlined upstream-contracts block with provenance). They are self-contained
 * string literals — no external files are read.
 *
 * @typedef {{ id: string, body: string }} IssueCase
 */

/**
 * Build a gold-standard issue body from parts. Every issue carries an
 * `## Upstream contracts (inlined)` section with a fenced js block and a
 * `Source of truth: #N` provenance line so it scores 7/7 — including the
 * 'None'-deps case, for consistency.
 * @param {{ title: string, ws: string, ac: string[], deps: string, impact: string, contractSource: string }} p
 * @returns {string}
 */
function goldIssue(p) {
  return [
    `## ${p.title}`,
    '',
    'Concrete, scoped change with a single responsibility.',
    '',
    '## Acceptance criteria',
    ...p.ac.map((a) => `- ${a}`),
    '',
    '## Dependencies',
    p.deps,
    '',
    'Token/context impact: ' + p.impact,
    '',
    '## Upstream contracts (inlined)',
    '```js',
    '/** @typedef {Object} UpstreamContract */',
    'export const CONTRACT = Object.freeze({ verified: true });',
    '```',
    `Source of truth: ${p.contractSource} — do not diverge.`,
    '',
    '## Background & evidence',
    `Grounded in the rebuild audit (${p.ws}).`,
    'See also https://code.visualstudio.com/docs/copilot/customization/hooks',
  ].join('\n');
}

/** @type {IssueCase[]} */
export const POSITIVE_CASES = [
  {
    id: 'E7-1-regression',
    body: goldIssue({
      title: 'Add script-level regression tests for foundation gaps',
      ws: 'ws1-artifact-audit.md:611',
      ac: [
        'Every Epic 0-3 fix has a named regression test.',
        'node --test exits 0 on Node 24+.',
      ],
      deps: 'Blocked by #23, #30.',
      impact: 'Test-only; no runtime token cost.',
      contractSource: '#30'
    }),
  },
  {
    id: 'E0-1-hooks',
    body: goldIssue({
      title: 'Build hook manifest loader and validator',
      ws: 'ws2-workflow-map.md:42',
      ac: [
        'loadHookManifest parses hooks.json.',
        'validateHookManifest rejects non-command entries.',
      ],
      deps: 'None',
      impact: 'Loads once per session; negligible.',
      contractSource: '#12'
    }),
  },
  {
    id: 'E2-5-argv',
    body: goldIssue({
      title: 'Implement no-shell argv command executor',
      ws: 'ws1-artifact-audit.md:640',
      ac: [
        'Commands spawn with shell:false.',
        'Per-command timeout kills runaway processes.',
      ],
      deps: 'Blocked by #17.',
      impact: 'Caps output to 4KB; reduces context cost.',
      contractSource: '#17'
    }),
  },
  {
    id: 'E6-2-trace',
    body: goldIssue({
      title: 'Create stable stepId-based trace reader',
      ws: 'ws3-external-grounding.md:118',
      ac: [
        'Duplicate labels with distinct stepIds stay separate.',
        'Malformed lines are counted, not thrown.',
      ],
      deps: 'Blocked by #46.',
      impact: 'Reads only the active task trace; bounded.',
      contractSource: '#46'
    }),
  },
  {
    id: 'E5-4-gate',
    body: goldIssue({
      title: 'Enforce backend-ready gate before Tier 5 E2E',
      ws: 'ws2-workflow-map.md:203',
      ac: [
        'Tier 5 blocks when health predicates fail.',
        'Stale gate throws immediately and forces a re-check.',
      ],
      deps: 'Blocked by #38.',
      impact: 'One health probe per check; minimal.',
      contractSource: '#38'
    }),
  },
];
