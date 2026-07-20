// @ts-check
/**
 * docs-sync.test.mjs
 *
 * CI gate: asserts that docs/AGENTS.md and the runtime agents/ directory are
 * consistent.
 *
 * Strict direction  (always hard-fail):
 *   Every .agent.md file in agents/ MUST be listed in docs/AGENTS.md.
 *   A file that exists without a docs entry is a documentation gap.
 *
 * Lenient direction (warn, don't fail):
 *   An active agent listed in docs/AGENTS.md MAY not have a .agent.md file
 *   yet — this is valid for planned agents that haven't been implemented.
 *   The test emits a console.warn for each missing file so it's visible in CI
 *   logs but does not block the build.
 *
 * Additional hard rules:
 *   - No deprecated agent appears in orchestrator.agent.md frontmatter agents list.
 *   - orchestrator frontmatter agents list contains only active agents from AGENTS.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_MD_PATH = join(REPO_ROOT, 'docs', 'AGENTS.md');
const AGENTS_DIR = join(REPO_ROOT, 'agents');
const ORCHESTRATOR_PATH = join(AGENTS_DIR, 'orchestrator.agent.md');

/**
 * Parse the Agent Roster table from AGENTS.md.
 * Returns { active: Set<string>, deprecated: Set<string> }
 *
 * Supports two first-column table formats:
 *   v2 backtick: | `agent-name` |
 *   v1 bold:     | **agent-name** |
 *
 * A row is deprecated if any cell in the row contains the word DEPRECATED.
 *
 * @returns {{ active: Set<string>, deprecated: Set<string> }}
 */
function parseAgentsDoc() {
  const content = readFileSync(AGENTS_MD_PATH, 'utf8');
  const active = new Set();
  const deprecated = new Set();

  const rowRegex = /^\|\s*(?:`([^`]+)`|\*\*([^*]+)\*\*)\s*\|(.*)$/gm;
  let match;
  while ((match = rowRegex.exec(content)) !== null) {
    const name = (match[1] ?? match[2]).trim();
    const rest = match[3];
    if (rest.toUpperCase().includes('DEPRECATED')) {
      deprecated.add(name);
    } else {
      active.add(name);
    }
  }

  return { active, deprecated };
}

/**
 * Parse the agents list from orchestrator.agent.md YAML frontmatter.
 * Handles both inline [ ] and block list YAML styles.
 *
 * @returns {string[]}
 */
function parseOrchestratorAgents() {
  const content = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (fmEnd === -1) return [];
  const fmLines = lines.slice(1, fmEnd);

  const unquote = (/** @type {string} */ s) => {
    const t = s.trim();
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (let i = 0; i < fmLines.length; i++) {
    const line = (fmLines.at(i) ?? '').trim();
    if (!line.startsWith('agents:')) continue;
    const value = line.slice('agents:'.length).trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      return value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .map((s) => s.trim())
        .filter(Boolean);
    }

    /** @type {string[]} */
    const out = [];
    for (let j = i + 1; j < fmLines.length; j++) {
      const itemLine = (fmLines.at(j) ?? '').trimStart();
      if (!itemLine.startsWith('- ')) break;
      const item = unquote(itemLine.slice(2).trim());
      if (item.length > 0) out.push(item);
    }
    return out;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('docs-sync › docs/AGENTS.md exists and is non-empty', () => {
  assert.ok(existsSync(AGENTS_MD_PATH), 'docs/AGENTS.md must exist');
  const content = readFileSync(AGENTS_MD_PATH, 'utf8');
  assert.ok(content.length > 100, 'docs/AGENTS.md must not be empty');
});

test('docs-sync › every active agent in AGENTS.md has a .agent.md file in agents/ (or is planned)', () => {
  const { active } = parseAgentsDoc();
  assert.ok(active.size > 0, 'AGENTS.md must list at least one active agent');

  // Lenient: warn for missing files (planned agents), do not fail
  for (const name of active) {
    const filePath = join(AGENTS_DIR, `${name}.agent.md`);
    if (!existsSync(filePath)) {
      // Planned agent — docs lists it but implementation PR hasn't landed yet
      console.warn(
        `[docs-sync] PLANNED: "${name}" is active in AGENTS.md but agents/${name}.agent.md does not exist yet.`
      );
    }
  }
  // No assertion — this direction is intentionally lenient
});

test('docs-sync › every .agent.md file in agents/ is listed in AGENTS.md (active or deprecated)', () => {
  // Strict direction: a file that exists MUST be documented
  const { active, deprecated } = parseAgentsDoc();
  const allDocumented = new Set([...active, ...deprecated]);

  const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.agent.md'));
  for (const file of agentFiles) {
    const name = file.replace('.agent.md', '');
    assert.ok(
      allDocumented.has(name),
      `agents/${file} exists in agents/ but "${name}" is not listed in docs/AGENTS.md`
    );
  }
});

test('docs-sync › no deprecated agent appears in orchestrator frontmatter agents list', () => {
  const { deprecated } = parseAgentsDoc();
  const orchestratorAgents = parseOrchestratorAgents();

  for (const name of orchestratorAgents) {
    assert.ok(
      !deprecated.has(name),
      `Deprecated agent "${name}" must not appear in orchestrator.agent.md agents list`
    );
  }
});

test('docs-sync › orchestrator frontmatter agents list contains only active agents from AGENTS.md', () => {
  const { active } = parseAgentsDoc();
  const orchestratorAgents = parseOrchestratorAgents();

  // orchestrator is not in its own agents list
  const activeExcludingOrchestrator = new Set([...active].filter((a) => a !== 'orchestrator'));

  for (const name of orchestratorAgents) {
    assert.ok(
      activeExcludingOrchestrator.has(name),
      `orchestrator lists "${name}" but it is not an active agent in AGENTS.md`
    );
  }
});

test('docs-sync › AGENTS.md contains a roster section header', () => {
  const content = readFileSync(AGENTS_MD_PATH, 'utf8');
  const hasRoster =
    /^## Agent Roster/m.test(content) ||
    /^## 1\. The roster at a glance/m.test(content);
  assert.ok(
    hasRoster,
    'AGENTS.md must have an agent roster section (## Agent Roster or ## 1. The roster at a glance)'
  );
});

test('docs-sync › diagnose entry in docs/AGENTS.md matches the hook-persisted scope contract', () => {
  const content = readFileSync(AGENTS_MD_PATH, 'utf8');
  const start = content.indexOf('### `diagnose`');
  assert.ok(start >= 0, 'docs/AGENTS.md must contain a diagnose section');

  const end = content.indexOf('\n### `', start + 1);
  const section = end >= 0 ? content.slice(start, end) : content.slice(start);

  assert.match(
    section,
    /allowedPaths\[\].*allowedGlobs\[\]/s,
    'diagnose docs must name allowedPaths[] and allowedGlobs[] as the scope boundary fields',
  );
  assert.match(
    section,
    /hook persists.*scope\.md|persisted by the hook to `scope\.md`/i,
    'diagnose docs must state that the hook persists scope.md from the return fields',
  );
  assert.doesNotMatch(
    section,
    /writes a `DiagnosisResult` plus `scope\.md`|scope\.md with `allowedFiles\[\]`/i,
    'diagnose docs must not claim the agent writes scope.md or uses the stale allowedFiles[] field',
  );
});

// ---------------------------------------------------------------------------
// New block — issue #214: orchestrator procedure/docs runtime sync
// ---------------------------------------------------------------------------

const EXPECTED_FEATURE_PIPELINE = [
  'discovery',
  'rubber-duck',
  'planner',
  'rubber-duck',
  'spec-writer',
];

test('docs-sync › orchestrator.agent.md lists pre-approval feature pipeline agents in order', () => {
  const md = readFileSync(ORCHESTRATOR_PATH, 'utf8');

  let cursor = 0;
  const firstRubberDuck = md.indexOf('Dispatch `@rubber-duck` with `mode=grill`', cursor);
  const secondRubberDuck = md.indexOf('Dispatch `@rubber-duck` with `mode=critique`', cursor);

  const markers = [
    md.indexOf('Dispatch `@discovery`', cursor),
    firstRubberDuck,
    md.indexOf('Dispatch `@planner`', cursor),
    secondRubberDuck,
    md.indexOf('Dispatch `@spec-writer`', cursor),
  ];

  for (let i = 0; i < EXPECTED_FEATURE_PIPELINE.length; i += 1) {
    const idx = markers[i];
    const name = EXPECTED_FEATURE_PIPELINE[i];
    assert.ok(idx > cursor, `Expected '${name}' to appear after previous pipeline step in orchestrator.agent.md`);
    cursor = idx;
  }
});

test('docs-sync › orchestrator procedure lib references resolve to real runtime files', () => {
  const requiredPaths = [
    'lib/workflow/orchestrator.mjs',
    'lib/workflow/lanes/feature.mjs',
    'lib/workflow/lanes/chore.mjs',
    'lib/workflow/bug-handoff.mjs',
    'lib/workflow/agents/security.mjs',
    'lib/workflow/lanes/security-tags.mjs',
    'lib/workflow/lanes/security-policy.mjs',
    'lib/persona-instructions.mjs',
    'lib/workstream-partitioner.mjs',
  ];

  for (const relPath of requiredPaths) {
    const absolute = join(REPO_ROOT, relPath);
    assert.ok(existsSync(absolute), `orchestrator procedure references missing runtime file: ${relPath}`);
  }
});

test('docs-sync › orchestrator procedure named functions exist in referenced runtime files', () => {
  const functionChecks = [
    { file: 'lib/workflow/orchestrator.mjs', fn: 'assertFullstackDispatchAllowed' },
    { file: 'lib/workflow/orchestrator.mjs', fn: 'assertDispatchResult' },
    { file: 'lib/workflow/lanes/feature.mjs', fn: 'continueApprovedFeature' },
    { file: 'lib/workstream-partitioner.mjs', fn: 'partitionWorkstreams' },
    { file: 'lib/persona-instructions.mjs', fn: 'loadPersonaInstructions' },
    { file: 'lib/workflow/lanes/security-policy.mjs', fn: 'evaluateSecurityPolicy' },
    { file: 'lib/workflow/lanes/security-tags.mjs', fn: 'deriveSecurityTags' },
    { file: 'lib/workflow/agents/security.mjs', fn: 'assertSecurityAgentAvailable' },
    { file: 'lib/workflow/bug-handoff.mjs', fn: 'validateDiagnosisResult' },
  ];

  // @bounded-alloc — reads one repo source file per entry of the fixed checklist above.
  for (const check of functionChecks) {
    const source = readFileSync(join(REPO_ROOT, check.file), 'utf8');
    const directExport = `export function ${check.fn}(`;
    const asyncExport = `export async function ${check.fn}(`;
    const reExport = `export { validateDiagnosisResult } from`;
    const hasDirectOrAsync = source.includes(directExport) || source.includes(asyncExport);
    const hasKnownReExport = check.fn === 'validateDiagnosisResult' && source.includes(reExport);
    assert.ok(
      hasDirectOrAsync || hasKnownReExport,
      `${check.file} must export function ${check.fn}() to satisfy orchestrator docs-runtime sync`,
    );
  }
});

// ---------------------------------------------------------------------------
// New block — issue #344: epic-10 conversational patterns + turn-lifecycle docs
// ---------------------------------------------------------------------------

const PATTERNS_MD_PATH = join(REPO_ROOT, 'docs', 'PATTERNS.md');
const DOCS_README_PATH = join(REPO_ROOT, 'docs', 'README.md');
const CONVERSATION_DOC_PATH = join(REPO_ROOT, 'docs', 'orchestrator-conversation.md');

/**
 * Every epic-10 pattern and the E10 story its Part-3 quick-map row must name.
 * The epic token is matched inside the row's Epic(s) cell, so a row may list
 * additional stories (e.g. P16 spans E10-01 and E10-03).
 * @type {ReadonlyArray<{ id: string, epic: string }>}
 */
const EPIC10_PATTERNS = Object.freeze([
  { id: 'P13', epic: 'E10-06' },
  { id: 'P14', epic: 'E10-4' },
  { id: 'P15', epic: 'E10-07' },
  { id: 'P16', epic: 'E10-01' },
  { id: 'P17', epic: 'E10-02' },
  { id: 'P18', epic: 'E10-05' },
]);

test('docs-sync › PATTERNS.md has a Part-2 entry heading for every epic-10 pattern id', () => {
  const lines = readFileSync(PATTERNS_MD_PATH, 'utf8').split('\n');
  for (const { id } of EPIC10_PATTERNS) {
    // `### P13 — …` — the trailing space + em dash disambiguates P1 from P13.
    const heading = `### ${id} — `;
    assert.ok(
      lines.some((line) => line.startsWith(heading)),
      `docs/PATTERNS.md must contain a "${heading}" pattern entry heading`
    );
  }
});

test('docs-sync › PATTERNS.md quick map has an epic-10 row for every epic-10 pattern', () => {
  const lines = readFileSync(PATTERNS_MD_PATH, 'utf8').split('\n');
  for (const { id, epic } of EPIC10_PATTERNS) {
    // A table row whose first cell starts with the pattern id and whose second
    // cell (Epic(s)) contains the E10 story token.
    const rowLine = lines.find((line) => line.startsWith(`| ${id} `));
    assert.ok(
      rowLine !== undefined,
      `docs/PATTERNS.md Part-3 quick map must have a "| ${id} " row`
    );
    const epicCell = rowLine.split('|')[2] ?? '';
    assert.ok(
      epicCell.includes(epic),
      `docs/PATTERNS.md quick-map row for ${id} must name ${epic} in its Epic(s) cell (got "${epicCell.trim()}")`
    );
  }
});

test('docs-sync › docs/orchestrator-conversation.md exists and is non-empty', () => {
  assert.ok(
    existsSync(CONVERSATION_DOC_PATH),
    'docs/orchestrator-conversation.md must exist (E10-08 turn-lifecycle narrative)'
  );
  const content = readFileSync(CONVERSATION_DOC_PATH, 'utf8');
  assert.ok(content.length > 100, 'docs/orchestrator-conversation.md must not be empty');
});

test('docs-sync › docs/README.md indexes the orchestrator-conversation doc', () => {
  const readme = readFileSync(DOCS_README_PATH, 'utf8');
  assert.ok(
    readme.includes('](./orchestrator-conversation.md)'),
    'docs/README.md must link to ./orchestrator-conversation.md in the docs index'
  );
});
