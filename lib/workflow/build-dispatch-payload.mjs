// @ts-check
import { readTextFileSync } from '../fs-safe.mjs';
import { buildTddPreamble, assertTddContract } from './tdd-contract.mjs';
import { normalizeVerification } from '../config/verification.mjs';
import { getOwn } from '../object-utils.mjs';
import {
  loadDomainContextForDispatch,
  DOMAIN_CONTEXT_MAX_TOKENS,
} from '../context/domain-context-load.mjs';
import { estimateTokens } from '../context/estimate-tokens.mjs';

/**
 * #151: token budget for the dispatch-time repo-memory section. A budget with no
 * default is a budget that never fires (TCM-1/TCM-9), so the memory injection —
 * unbounded before this — is capped here and degrades LOUDLY (digest + pointer)
 * rather than pasting a whole .devmate/MEMORY.md verbatim. Mirrors DOMAIN_CONTEXT_MAX_TOKENS.
 */
// TODO: calibrate after S3 measurement — provisional placeholder (#147 pipeline baseline)
export const MEMORY_CONTEXT_MAX_TOKENS = 1500;

/** Head lines kept in the memory digest fallback when the section is over budget. */
// TODO: calibrate after S3 measurement — provisional placeholder
const MEMORY_DIGEST_HEAD_LINES = 12;

/**
 * Loud digest fallback for an over-budget repo-memory section: the first
 * MEMORY_DIGEST_HEAD_LINES lines plus the markdown heading list — enough of a map
 * for a worker to decide whether to read the full `.devmate/MEMORY.md`.
 * @param {string} memory
 * @returns {string}
 */
function buildMemoryDigest(memory) {
  const lines = memory.split(/\r?\n/);
  const head = lines.slice(0, MEMORY_DIGEST_HEAD_LINES).join('\n').trimEnd();
  const headingLine = memoryHeadings(memory);
  return [head, headingLine].filter((part) => part !== '').join('\n');
}

/**
 * The markdown heading map of the memory — the smallest useful digest, used as
 * the secondary fallback when even the head+headings digest is over budget.
 * @param {string} memory
 * @returns {string}
 */
function memoryHeadings(memory) {
  const headings = memory
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.trim());
  return headings.length > 0 ? `Headings: ${headings.join(' | ')}` : '';
}

/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('./tdd-contract.mjs').TddApproach} TddApproach */

/**
 * @typedef {Object} PlanTask
 * @property {string} id
 * @property {string} [description]
 * @property {TddApproach|TddApproach[]} [tddApproach]
 */

/**
 * @typedef {Object} PlanShape
 * @property {PlanTask[]} tasks
 */

/**
 * B3/B4: pre-loaded session context threaded into a dispatch. `repoMemories` is
 * the map produced at session start — keyed by repo name, value is that repo's
 * own memory-file contents. A repo whose memory file did not exist is simply
 * absent from the map (B4 defaults such a repo to an empty string).
 * @typedef {Object} SessionContext
 * @property {Record<string, string>} [repoMemories]  Repo name -> memory-file contents.
 * @property {number} [memoryMaxTokens]  Issue 151: per-dispatch repo-memory section
 *   budget override; defaults to MEMORY_CONTEXT_MAX_TOKENS. Mirrors
 *   DomainDispatchOptions.maxTokens — a positive finite number when provided.
 */

/**
 * AC-5: one global acceptance criterion assigned to a dispatch. `id` is the
 * GLOBAL 1-based id — the `AC{n}` numbering rendered into spec.md
 * (`lib/spec-writer.mjs`, `index + 1`) and parsed back by
 * `lib/spec-progress.mjs` — resolved from the plan's task-local labels via
 * `deriveTaskAcAssignments` (`lib/workflow/agents/spec-writer.mjs`).
 * @typedef {Object} TargetAc
 * @property {number} id    Global 1-based acceptance-criterion id.
 * @property {string} text  Criterion text (rendered capped in the payload).
 */

/**
 * DN-3: input for the budgeted domain-context section. The caller reads the
 * DN-2 state file at `.devmate/state/domain-context.json` by known path and
 * passes the parsed state plus an injected reader — the builder itself never
 * touches the filesystem for domain context, so it stays testable and repos
 * without domains keep byte-identical payloads.
 * @typedef {Object} DomainDispatchOptions
 * @property {import('../types.mjs').DomainContextState|null} state  Parsed domain-context.json, or null when the file is absent.
 * @property {string} repoRoot  Absolute repo root for resolving contextFile paths.
 * @property {(p: string) => string|null} readFile  Injected reader (null = missing).
 * @property {number} [maxTokens]  Section budget override; defaults to DOMAIN_CONTEXT_MAX_TOKENS.
 */

/**
 * E10-06 (R6): every dispatch prompt must carry an objective, an output
 * format, tool guidance, and task boundaries — under-specified subagents
 * duplicate work. The four fields are required; `buildDispatchPayload`
 * throws when any is missing or empty.
 * @typedef {Object} BuildDispatchPayloadOptions
 * @property {string} objective     What this dispatch must accomplish (single task statement).
 * @property {string} outputFormat  The exact result shape the subagent must return.
 * @property {string} toolGuidance  Which tools to use or avoid for this dispatch.
 * @property {string} boundaries    Task boundaries: what is out of scope for this dispatch.
 * @property {string} persona
 * @property {object[]} tasks
 * @property {string} planPath
 * @property {DevmateConfig} config
 * @property {SessionContext} [sessionContext]  B4: session context (multi-root only).
 * @property {TargetAc[]} [targetAcs]  AC-5: this dispatch's global AC assignment (implementation dispatches only).
 * @property {DomainDispatchOptions} [domainContext]  DN-3: domain-context injection input (domains-configured repos only).
 */

/**
 * The dispatch-completeness fields required on every payload (E10-06 R6
 * poka-yoke). Order matters only for error reporting: the first missing
 * field is the one named in the thrown error.
 * @type {ReadonlyArray<'objective'|'outputFormat'|'toolGuidance'|'boundaries'>}
 */
export const REQUIRED_DISPATCH_FIELDS = Object.freeze([
  'objective',
  'outputFormat',
  'toolGuidance',
  'boundaries',
]);

/**
 * Reject under-specified dispatch payloads: each required field must be a
 * non-empty string. Throws a clear error naming the first missing field so
 * the orchestrator (or a test) can see exactly what was omitted.
 * @param {BuildDispatchPayloadOptions} opts
 * @returns {void}
 */
function assertDispatchCompleteness(opts) {
  for (const field of REQUIRED_DISPATCH_FIELDS) {
    const value = getOwn(opts, field);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `buildDispatchPayload: missing required dispatch field '${field}' — ` +
        'every dispatch must carry objective, outputFormat, toolGuidance, and boundaries',
      );
    }
  }
}

/**
 * Render the four completeness fields as prompt sections, in required-field
 * order, so every dispatched subagent sees its objective, the expected
 * output format, tool guidance, and task boundaries.
 * @param {BuildDispatchPayloadOptions} opts
 * @returns {string}
 */
function buildCompletenessSections(opts) {
  return [
    '## Objective',
    '',
    opts.objective,
    '',
    '## Output format',
    '',
    opts.outputFormat,
    '',
    '## Tool guidance',
    '',
    opts.toolGuidance,
    '',
    '## Boundaries',
    '',
    opts.boundaries,
    '',
  ].join('\n');
}

/**
 * @param {PlanTask} task
 * @returns {TddApproach[]}
 */
function toTddEntries(task) {
  if (!task.tddApproach) return [];
  return Array.isArray(task.tddApproach) ? task.tddApproach : [task.tddApproach];
}

/**
 * @param {DevmateConfig} config
 * @param {string} persona
 * @returns {string}
 */
function buildPersonaContext(config, persona) {
  const personaEntry = config.personas.find((entry) => entry.persona === persona);
  if (!personaEntry) {
    return `## Persona context\n\n- Persona: ${persona}\n- Config entry: [MISSING]\n`;
  }

  const editable = personaEntry.editableGlobs.join(', ');
  const offLimits = (personaEntry.offLimitsGlobs ?? []).join(', ') || '[none]';
  const testGlobs = (personaEntry.testGlobs ?? []).join(', ') || '[not configured]';

  return [
    '## Persona context',
    '',
    `- Persona: ${personaEntry.persona}`,
    `- Editable globs: ${editable}`,
    `- Off-limits globs: ${offLimits}`,
    `- Persona test globs: ${testGlobs}`,
    '',
  ].join('\n');
}

/**
 * DN-3: fail closed on a malformed domainContext option (E10-06 poka-yoke,
 * mirroring the targetAcs strictness): a provided-but-broken wiring input
 * must throw a clear error naming the field, never silently degrade every
 * domain to a "context file missing" note. Absent/empty *state* stays
 * fail-open — that is runtime data, not caller wiring.
 * @param {DomainDispatchOptions} domainOpts
 * @returns {void}
 */
function assertDomainContextShape(domainOpts) {
  if (typeof domainOpts.repoRoot !== 'string' || domainOpts.repoRoot.trim() === '') {
    throw new Error(
      'buildDispatchPayload: domainContext.repoRoot must be a non-empty string when domainContext is provided',
    );
  }
  if (typeof domainOpts.readFile !== 'function') {
    throw new Error(
      'buildDispatchPayload: domainContext.readFile must be a function when domainContext is provided',
    );
  }
  // Destructured to a neutral name: the no-insecure-comparison lint treats
  // comparisons on token-named identifiers as secret comparison.
  const { maxTokens: budgetOverride } = domainOpts;
  if (budgetOverride !== undefined && (!Number.isFinite(budgetOverride) || budgetOverride <= 0)) {
    throw new Error(
      'buildDispatchPayload: domainContext.maxTokens must be a positive finite number when provided',
    );
  }
}

/**
 * DN-3: render the budgeted per-domain context section, one `## Domain
 * context: <id>` block per active domain in rank order. Renders nothing (empty
 * string, no header) when no domain input was passed, the state is absent, or
 * it holds no matches — repos without domains keep byte-identical payloads.
 * Degradation is loud, never silent (TCM-9): an over-budget context file
 * renders a digest plus an explicit pointer naming the file, and a missing
 * one renders a "context file missing" note.
 * @param {import('../types.mjs').DomainContextState|null|undefined} domainContextState
 * @param {BuildDispatchPayloadOptions} opts
 * @returns {string}
 */
function buildDomainContextSection(domainContextState, opts) {
  const domainOpts = opts.domainContext;
  if (!domainOpts) return '';
  assertDomainContextShape(domainOpts);
  if (!domainContextState) return '';
  if (!Array.isArray(domainContextState.matches) || domainContextState.matches.length === 0) {
    return '';
  }

  const entries = loadDomainContextForDispatch({
    repoRoot: domainOpts.repoRoot,
    state: domainContextState,
    maxTokens: domainOpts.maxTokens ?? DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: domainOpts.readFile,
  });
  if (entries.length === 0) return '';

  /** @type {string[]} */
  const lines = [];
  for (const entry of entries) {
    lines.push(`## Domain context: ${entry.domain}`, '');
    lines.push(`- Owns: ${entry.globs.join(', ') || '[no globs matched]'}`);
    lines.push(`- Related: ${entry.relatedDomains.join(', ') || '[none]'}`);
    lines.push('');
    if (entry.missing) {
      lines.push(
        entry.contextFile === null
          ? '[no context file declared for this domain]'
          : `[context file missing: ${entry.contextFile}]`,
      );
      lines.push('');
      continue;
    }
    if (entry.truncated) {
      lines.push(
        `[context file over budget — digest below; read ${entry.contextFile} for the rest]`,
      );
      // (entry.digest ?? '') instead of a comparison: the no-insecure-comparison
      // lint treats ===/!== on digest-named identifiers as secret comparison.
      const digestText = entry.digest ?? '';
      if (digestText.length > 0) {
        lines.push('', digestText);
      }
      lines.push('');
      continue;
    }
    lines.push(/** @type {string} */ (entry.content).trimEnd(), '');
  }
  return lines.join('\n');
}

/**
 * AC-5: per-AC text cap for the target-AC section. No existing
 * dispatch-payload cap applies here, so this mirrors MAX_LABEL in
 * scripts/complete-ac.mjs (the cap on the trace label the same ids feed).
 * TODO: calibrate — provisional placeholder.
 */
const TARGET_AC_TEXT_CAP = 120;

/**
 * Deterministic single-line truncation so the target-AC section stays
 * bounded (TCM-9: ids + short text, never spec paste).
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function capAcText(text, maxLen) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(1, maxLen - 3)).trimEnd()}...`;
}

/**
 * AC-5: render the explicit global AC assignment for an implementation
 * dispatch. Returns '' when the dispatch carries no ACs — non-implementation
 * dispatches omit the section cleanly, with no crash and no spurious ids.
 * Fails closed on a malformed assignment (non-array, duplicate or
 * non-positive-integer id, empty text) rather than dispatching wrong ids.
 * Entries render in ascending global-id order regardless of caller order, so
 * the section is canonical even when the assignment was built from a
 * set/map or filtered subset.
 * @param {TargetAc[]|undefined} targetAcs
 * @returns {string}
 */
function buildTargetAcSection(targetAcs) {
  if (targetAcs === undefined) return '';
  if (!Array.isArray(targetAcs)) {
    throw new Error('buildDispatchPayload: targetAcs must be an array when provided');
  }
  if (targetAcs.length === 0) return '';

  /** @type {Set<number>} */
  const seen = new Set();
  for (const entry of targetAcs) {
    const id = entry?.id;
    if (!Number.isInteger(id) || /** @type {number} */ (id) < 1 || seen.has(/** @type {number} */ (id))) {
      throw new Error(
        `buildDispatchPayload: targetAcs ids must be unique positive integers, got '${String(id)}'`,
      );
    }
    seen.add(/** @type {number} */ (id));
    if (typeof entry.text !== 'string' || entry.text.trim() === '') {
      throw new Error(
        `buildDispatchPayload: targetAcs entry AC${String(id)} is missing its text`,
      );
    }
  }

  const ordered = [...targetAcs].sort((a, b) => a.id - b.id);
  const ids = ordered.map((entry) => entry.id);
  return [
    '## Target acceptance criteria',
    '',
    `- targetAcIds: [${ids.join(', ')}]`,
    ...ordered.map((entry) => `- AC${entry.id}: ${capAcText(entry.text, TARGET_AC_TEXT_CAP)}`),
    '',
    'These ids are GLOBAL — the AC{n} numbering in spec.md. Report completedAcIds',
    'as a subset of targetAcIds, verbatim; never renumber to task-local labels.',
    '',
  ].join('\n');
}

/**
 * @param {object[]} tasks
 * @returns {string}
 */
function buildTaskSection(tasks) {
  /** @type {string[]} */
  const lines = ['## Task list', ''];
  for (const [index, task] of tasks.entries()) {
    lines.push(`${index + 1}. ${JSON.stringify(task)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the dynamic verification-check list into the dispatch prompt. Commands
 * are opaque text (never executed here). Legacy unitTest/typeCheck/e2e configs
 * are normalized to checks first, so old and new configs both render. An empty
 * verification block renders a single `[NONE CONFIGURED]` line.
 * @param {DevmateConfig} config
 * @returns {string}
 */
function buildVerificationSection(config) {
  const { checks } = normalizeVerification(config.verification);

  /** @type {string[]} */
  const lines = ['## Verification', ''];
  if (checks.length === 0) {
    lines.push('- [NONE CONFIGURED]', '');
    return lines.join('\n');
  }
  for (const check of checks) {
    const command = check.command?.trim() || '[NOT CONFIGURED]';
    const optional = check.optional ? ' (optional)' : '';
    lines.push(`- ${check.category} [${check.id}]${optional}: ${command}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * B4: In multi-root mode, inject the dispatched persona's absolute repo path and
 * the repo-scoped memory pre-loaded at session start. The persona MUST exist in
 * the multi-root config — an unknown persona is a dispatch error and throws.
 * A repo with no memory entry defaults to an empty string (no throw). Returns
 * an empty string in single-root mode so the payload is byte-for-byte unchanged.
 *
 * @param {DevmateConfig} config
 * @param {string} persona
 * @param {SessionContext} [sessionContext]
 * @returns {string}
 */
function buildRepoContextSection(config, persona, sessionContext) {
  if (config.mode !== 'multi-root') return '';

  const personaEntry = config.personas.find((entry) => entry.persona === persona);
  if (!personaEntry) {
    throw new Error(
      `buildDispatchPayload: persona '${persona}' not found in multi-root config`,
    );
  }

  const repo = /** @type {string} */ (personaEntry.repo);
  const repoPath = /** @type {string} */ (personaEntry.repoPath);
  const repoMemories = sessionContext?.repoMemories;
  const repoMemory = (repoMemories ? getOwn(repoMemories, repo) : undefined) ?? '';

  return [
    '## Repo context',
    '',
    `- Repo: ${repo}`,
    `- Repo path: ${repoPath}`,
    '',
    '### Repo memory',
    '',
    ...renderMemoryBody(repoMemory, sessionContext?.memoryMaxTokens),
    '',
  ].join('\n');
}

/**
 * #151: render the repo-memory body under a token budget. Under budget the body
 * is byte-identical to the pre-#151 verbatim paste; over budget it degrades
 * loudly to a digest plus an explicit pointer to `.devmate/MEMORY.md` (TCM-9 —
 * never a silent large paste, never a silent drop). Mirrors the DN-3 domain
 * section. `memoryMaxTokens` overrides the default when a positive finite number.
 * @param {string} memory
 * @param {number} [memoryMaxTokens]
 * @returns {string[]}
 */
function renderMemoryBody(memory, memoryMaxTokens) {
  if (memory === '') return ['[none]'];

  // Aliased to a neutral name (the no-insecure-comparison lint treats comparisons
  // on token-named identifiers as secret comparison) and validated exactly like
  // domainContext.maxTokens.
  const budgetOverride = memoryMaxTokens;
  if (budgetOverride !== undefined && (!Number.isFinite(budgetOverride) || budgetOverride <= 0)) {
    throw new Error(
      'buildDispatchPayload: memoryMaxTokens must be a positive finite number when provided',
    );
  }
  const budget = budgetOverride ?? MEMORY_CONTEXT_MAX_TOKENS;

  if (estimateTokens(memory) <= budget) return [memory];

  // Secondary clamp (#151 review), mirroring the DN-3 domain section: the digest
  // itself must fit the budget. A pathological memory (all headings, or very long
  // head lines) can make the head+headings digest nearly as large as the file, so
  // fall back to headings-only, then to marker-only, keeping the cap honest.
  // (.length compared, not the digest string: the no-insecure-comparison lint
  // treats ===/!== on digest-named identifiers as secret comparison.)
  let digestText = buildMemoryDigest(memory);
  if (estimateTokens(digestText) > budget) {
    const headingsOnly = memoryHeadings(memory);
    digestText = estimateTokens(headingsOnly) <= budget ? headingsOnly : '';
  }
  const lines = ['[repo memory over budget — digest below; read .devmate/MEMORY.md for the rest]'];
  if (digestText.length > 0) lines.push('', digestText);
  return lines;
}

/**
 * Builds a runSubagent dispatch prompt from a template, rejecting
 * under-specified payloads (E10-06 R6): objective, outputFormat,
 * toolGuidance, and boundaries are required so no dispatched subagent is
 * missing its objective, output format, tool guidance, or task boundaries.
 * Always prepends a TDD preamble derived from the plan's tddApproach entries.
 * Never hardcodes test commands — reads from config.verification.
 * When `targetAcs` is provided (implementation dispatches), the payload also
 * names the dispatch's explicit GLOBAL acceptance-criterion ids (AC-5), so
 * the subagent reports completedAcIds without local→global inference.
 * When `domainContext` is provided (DN-3, domains-configured repos only), a
 * budgeted per-domain context section renders after the persona context, so
 * the worker starts with high-precision domain knowledge instead of
 * rediscovering it via tool calls.
 *
 * @param {BuildDispatchPayloadOptions} opts
 * @returns {string}
 * @throws if objective, outputFormat, toolGuidance, or boundaries is missing/empty.
 */
export function buildDispatchPayload(opts) {
  assertDispatchCompleteness(opts);

  const rawPlan = readTextFileSync(opts.planPath);
  const plan = /** @type {PlanShape} */ (JSON.parse(rawPlan));
  assertTddContract(plan);

  const allApproaches = plan.tasks.flatMap((task) => toTddEntries(task));
  const sections = [
    buildTddPreamble(allApproaches, opts.config),
    buildCompletenessSections(opts),
    buildPersonaContext(opts.config, opts.persona),
  ];

  const domainSection = buildDomainContextSection(opts.domainContext?.state, opts);
  if (domainSection !== '') sections.push(domainSection);
  sections.push(buildTaskSection(opts.tasks));

  const targetAcSection = buildTargetAcSection(opts.targetAcs);
  if (targetAcSection !== '') sections.push(targetAcSection);
  sections.push(buildVerificationSection(opts.config));

  const repoContext = buildRepoContextSection(opts.config, opts.persona, opts.sessionContext);
  if (repoContext !== '') sections.push(repoContext);

  return sections.join('\n');
}
