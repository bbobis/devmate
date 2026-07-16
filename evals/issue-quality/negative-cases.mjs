// @ts-check
/**
 * E7-6: Negative issue-quality eval cases. Each body breaks exactly ONE
 * dimension; `defect` names the IssueQualityScore boolean expected to be false.
 *
 * @typedef {import('../../lib/types.mjs').IssueQualityScore} IssueQualityScore
 * @typedef {{ id: string, defect: keyof IssueQualityScore, body: string }} NegativeCase
 */

const AC = ['## Acceptance criteria', '- First criterion.', '- Second criterion.'].join('\n');
const DEPS = ['## Dependencies', 'None'].join('\n');
// Dependencies that reference a real upstream issue (#N) — triggers the
// contractsInlined requirement.
const DEPS_WITH_REF = ['## Dependencies', 'Blocked by #38.'].join('\n');
const IMPACT = 'Token/context impact: bounded reads only.';
const BG = [
  '## Background & evidence',
  'Grounded in ws1-artifact-audit.md:611 and https://docs.github.com/copilot.',
].join('\n');
// A well-formed inlined-contracts block (with provenance) for reuse.
const CONTRACT_BLOCK = [
  '## Upstream contracts (inlined)',
  '```js',
  'export const CONTRACT = Object.freeze({ verified: true });',
  '```',
  'Source of truth: #38 — do not diverge.',
].join('\n');
// The same block but missing the `Source of truth: #N` provenance line.
const CONTRACT_BLOCK_NO_SOURCE = [
  '## Upstream contracts (inlined)',
  '```js',
  'export const CONTRACT = Object.freeze({ verified: true });',
  '```',
].join('\n');

/** @type {NegativeCase[]} */
export const NEGATIVE_CASES = [
  {
    // Noun title (not imperative) → titleImperative=false.
    id: 'noun-title',
    defect: 'titleImperative',
    body: ['## Hook registration', '', AC, '', DEPS, '', IMPACT, '', BG].join('\n'),
  },
  {
    // No citation anywhere → problemCited=false.
    id: 'no-citation',
    defect: 'problemCited',
    body: [
      '## Add hook registration validator',
      '',
      AC,
      '',
      DEPS,
      '',
      IMPACT,
      '',
      '## Background & evidence',
      'This is needed because the old approach was fragile.',
    ].join('\n'),
  },
  {
    // Only one AC bullet → hasAcceptanceCriteria=false.
    id: 'single-ac',
    defect: 'hasAcceptanceCriteria',
    body: [
      '## Add hook registration validator',
      '',
      '## Acceptance criteria',
      '- Only one criterion.',
      '',
      DEPS,
      '',
      IMPACT,
      '',
      BG,
    ].join('\n'),
  },
  {
    // No Dependencies section → dependencyListed=false.
    id: 'no-deps',
    defect: 'dependencyListed',
    body: ['## Add hook registration validator', '', AC, '', IMPACT, '', BG].join('\n'),
  },
  {
    // No token/context impact → tokenImpactStated=false.
    id: 'no-token-impact',
    defect: 'tokenImpactStated',
    body: ['## Add hook registration validator', '', AC, '', DEPS, '', BG].join('\n'),
  },
  {
    // Dependencies reference #38 but no inlined contracts block exists →
    // contractsInlined=false. All other dimensions pass.
    id: 'dep-ref-no-inlined-block',
    defect: 'contractsInlined',
    body: ['## Add hook registration validator', '', AC, '', DEPS_WITH_REF, '', IMPACT, '', BG].join('\n'),
  },
  {
    // An inlined contracts block exists but lacks the `Source of truth: #N`
    // provenance line → externalClaimsSourced=false. All other dimensions pass.
    id: 'inlined-block-no-provenance',
    defect: 'externalClaimsSourced',
    body: [
      '## Add hook registration validator',
      '',
      AC,
      '',
      DEPS_WITH_REF,
      '',
      IMPACT,
      '',
      CONTRACT_BLOCK_NO_SOURCE,
      '',
      BG,
    ].join('\n'),
  },
];

/**
 * A fully-grounded issue body that satisfies all seven dimensions (scores 7/7).
 * Used to assert the happy path including the two #81 dimensions.
 * @type {string}
 */
export const FULLY_GROUNDED = [
  '## Add hook registration validator',
  '',
  AC,
  '',
  DEPS_WITH_REF,
  '',
  IMPACT,
  '',
  CONTRACT_BLOCK,
  '',
  BG,
].join('\n');

/**
 * An all-bad issue body that fails every dimension (used to assert score=0).
 * @type {string}
 */
export const ALL_BAD = [
  '## Hook registration',
  '',
  'Some vague description without structure.',
].join('\n');
