// @ts-check
import { readTextFileSync } from './fs-safe.mjs';
import { getOwn } from './object-utils.mjs';

/**
 * @typedef {Object} AgentFrontmatter
 * @property {string[]} tools           Tool names declared (e.g. 'edit', 'execute', 'search').
 * @property {string[]} [capabilities]  Additional capability tokens.
 * @property {string[]} [skills]        Mandatory skill names declared (e.g. 'tdd-debug').
 * @property {string[]} [agents]        Declared subagent names (e.g. 'planner').
 * @property {string} [name]            Agent name from frontmatter.
 * @property {string} [outputScope]     e.g. 'session-only' | 'repo' | 'any'.
 * @property {string[]} [model]         Qualified model names, e.g. ['Claude Opus 4.8 (copilot)'].
 *                                      Absent means the agent inherits the model picker (see
 *                                      checkModelRule). A scalar `model:` normalizes to a
 *                                      one-element array; the array form is VS Code's
 *                                      *availability* fallback, not a difficulty ladder.
 */

/**
 * Validation result for the TDD skill rule (checkTddSkillRule).
 * @typedef {Object} TddSkillValidationResult
 * @property {boolean} passed      True if the agent declares tdd-debug as mandatory.
 * @property {string}  agentName   The agent that was checked.
 * @property {string}  [violation] Description if passed is false.
 */

/**
 * @typedef {'writes-files'|'runs-checks'|'invokes-command'|'read-only'} BodyClaimType
 */

/**
 * @typedef {Object} BodyClaim
 * @property {BodyClaimType} type
 * @property {number} line       Line number in the agent file.
 * @property {string} excerpt    The phrase that triggered this claim.
 */

/**
 * @typedef {Object} AgentValidationResult
 * @property {string} filePath
 * @property {boolean} ok
 * @property {AgentViolation[]} violations
 */

/**
 * @typedef {Object} AgentViolation
 * @property {BodyClaim} claim
 * @property {string} requiredTool   The tool that must be in frontmatter.
 * @property {string} message
 */

// Minimal line-by-line YAML parser sufficient for simple agent frontmatter.
// Limitation: does not support multi-line values, anchors, or complex YAML.
// Only parses string scalars and inline flow-style string arrays.

/**
 * Parse YAML frontmatter from an agent markdown file.
 * Returns an empty object (with empty tools) if no frontmatter block is present.
 * @param {string} fileContent
 * @returns {AgentFrontmatter}
 */
export function parseAgentFrontmatter(fileContent) {
  const lines = fileContent.split('\n');
  if (lines[0].trim() !== '---') {
    return { tools: [] };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { tools: [] };
  }
  const frontmatterLines = lines.slice(1, endIndex);

  /** @type {AgentFrontmatter} */
  const result = { tools: [] };
  let currentField = '';
  let inArray = false;

  const unquote = (/** @type {string} */ value) => {
    const trimmed = value.trim();
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };

  for (const line of frontmatterLines) {
    const trimmed = line.trim();

    // Inline array: tools: ['edit', 'execute']
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const field = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      // Accept only simple keys [A-Za-z0-9_-]+.
      let fieldOk = true;
      for (let ci = 0; ci < field.length; ci++) {
        const code = field.charCodeAt(ci);
        const isUpper = code >= 65 && code <= 90;
        const isLower = code >= 97 && code <= 122;
        const isDigit = code >= 48 && code <= 57;
        if (!(isUpper || isLower || isDigit || code === 95 || code === 45)) {
          fieldOk = false;
          break;
        }
      }
      if (!fieldOk) {
        if (!line.startsWith(' ') && !line.startsWith('\t')) inArray = false;
        continue;
      }

      if (value.startsWith('[') && value.endsWith(']')) {
        const raw = value.slice(1, -1);
        const items = raw
          .split(',')
          .map((s) => unquote(s))
          .filter(Boolean);
        if (field === 'tools') result.tools = items;
        else if (field === 'capabilities') result.capabilities = items;
        else if (field === 'skills') result.skills = items;
        else if (field === 'agents') result.agents = items;
        else if (field === 'model') result.model = items;
        inArray = false;
        currentField = '';
        continue;
      }

      // Block array header: tools:
      if (value.length === 0) {
        currentField = field;
        inArray = true;
        continue;
      }

      // Scalar: key: value
      if (!inArray) {
        const val = unquote(value);
        if (field === 'outputScope') result.outputScope = val;
        else if (field === 'name') result.name = val;
        else if (field === 'model') result.model = [val];
        currentField = field;
        inArray = false;
        continue;
      }
    }

    // Block array item: - value
    const itemLine = line.trimStart();
    if (inArray && itemLine.startsWith('- ')) {
      const val = unquote(itemLine.slice(2));
      if (currentField === 'tools') result.tools.push(val);
      else if (currentField === 'capabilities') {
        if (!result.capabilities) result.capabilities = [];
        result.capabilities.push(val);
      } else if (currentField === 'skills') {
        if (!result.skills) result.skills = [];
        result.skills.push(val);
      } else if (currentField === 'agents') {
        if (!result.agents) result.agents = [];
        result.agents.push(val);
      } else if (currentField === 'model') {
        if (!result.model) result.model = [];
        result.model.push(val);
      }
      continue;
    }

    // Any other non-indented line resets array state
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      inArray = false;
    }
  }
  return result;
}

/**
 * Return true when a character is considered a word character for boundary checks.
 * @param {string} ch
 * @returns {boolean}
 */
function isWordChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  return isUpper || isLower || isDigit || ch === '_';
}

/**
 * Boundary-aware whole-word containment check.
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
function containsWord(haystack, needle) {
  for (
    let idx = haystack.indexOf(needle);
    idx !== -1;
    idx = haystack.indexOf(needle, idx + 1)
  ) {
    const before = haystack.charAt(idx - 1);
    const after = haystack.charAt(idx + needle.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
  }
  return false;
}

/**
 * A literal command invocation in an agent body: `node …/foo.mjs`, `npm run x`,
 * or `npx x`. Static patterns — never built from a runtime value.
 *
 * This is deliberately NOT a prose claim. The `runs-checks` word list ("run",
 * "verify", "check") matches sentences that merely *describe* what a subagent
 * does, which is why dispatcher agents are waived from it. A literal command is
 * different in kind: it is an instruction the agent is expected to execute
 * itself, and it is meaningless without an `execute` tool.
 *
 * The orchestrator carried ~20 of these — `init-task-state`,
 * `orch-assert-dispatch`, `gatectl`, `merge-discovery`, `verify-step` — while
 * declaring `tools: ['agent', 'read', 'search', 'todo']`. Every one was inert:
 * task state was never created, dispatch results were never validated, and the
 * model, unable to run the script, fell back to SEARCHING for it, found nothing
 * (the plugin dir is outside the workspace), concluded the tooling was broken,
 * and did the work inline — the exact delegation violation the same prompt
 * forbids. CI stayed green because the dispatcher waiver swallowed it.
 * @type {RegExp[]}
 */
const COMMAND_PATTERNS = [
  /\bnode\s+["'`]?\S*\.mjs\b/,
  /\bnpm\s+run\s+\S+/,
  /\bnpx\s+\S+/,
];

/**
 * Detect a claim type from one body line.
 * @param {string} line
 * @returns {{ type: BodyClaimType, excerpt: string }|null}
 */
function detectClaim(line) {
  const text = line.toLowerCase();

  // Checked FIRST: a literal command must not be misclassified as a prose
  // `runs-checks` claim, which the dispatcher waiver would then let through
  // (e.g. `node .../check-session-budget.mjs` contains the word "check").
  for (const pattern of COMMAND_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return { type: 'invokes-command', excerpt: match[0].trim() };
  }

  /** @type {string[]} */
  const writeWords = ['write', 'writes', 'create', 'creates', 'edit', 'edits'];
  for (const w of writeWords) {
    if (containsWord(text, w)) return { type: 'writes-files', excerpt: w };
  }
  if (containsWord(text, 'update') || containsWord(text, 'updates')) {
    const pos = text.indexOf('update');
    if (pos !== -1 && pos + 7 < text.length) return { type: 'writes-files', excerpt: 'update' };
    const posPlural = text.indexOf('updates');
    if (posPlural !== -1 && posPlural + 8 < text.length) return { type: 'writes-files', excerpt: 'updates' };
  }
  if ((containsWord(text, 'save') || containsWord(text, 'saves')) && text.includes(' to ')) {
    return { type: 'writes-files', excerpt: 'save to' };
  }

  /** @type {string[]} */
  const runWords = ['run', 'runs', 'execute', 'executes', 'check', 'checks', 'verify', 'verifies', 'lint', 'lints'];
  for (const w of runWords) {
    if (containsWord(text, w)) return { type: 'runs-checks', excerpt: w };
  }

  return null;
}

/**
 * Scan agent body markdown for behavioral claim phrases.
 * Recognized patterns documented in `docs/agent-capability-rules.md`.
 * @param {string} fileContent
 * @returns {BodyClaim[]}
 */
export function extractBodyClaims(fileContent) {
  // Strip frontmatter block before scanning body
  const allLines = fileContent.split('\n');
  let fmLineCount = 0;
  let bodyLines = allLines;

  if (allLines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < allLines.length; i++) {
      if (allLines[i].trim() === '---') { end = i; break; }
    }
    if (end !== -1) {
      fmLineCount = end + 1;
      bodyLines = allLines.slice(end + 1);
    }
  }

  /** @type {BodyClaim[]} */
  const claims = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const detected = detectClaim(line);
    if (!detected) continue;
    const lineNum = fmLineCount + i + 1;
    // Only emit one claim per line per type
    const existing = claims.find((c) => c.type === detected.type && c.line === lineNum);
    if (!existing) {
      claims.push({ type: detected.type, line: lineNum, excerpt: detected.excerpt });
    }
  }
  return claims;
}

/**
 * Determine whether an agent's frontmatter indicates it can write files.
 * Write capability is signaled by the 'edit' (or aliased) tool being declared.
 * @param {AgentFrontmatter} frontmatter
 * @returns {boolean}
 */
export function isWriteCapable(frontmatter) {
  const tools = (frontmatter.tools ?? []).map((t) => t.replace(/^['"]|['"]$/g, '').trim());
  return tools.some((t) => t === 'edit' || t === 'edit/file' || t === 'create/file');
}

/**
 * Check whether a write-capable agent declares 'tdd-debug' as a mandatory skill.
 * Read-only agents always pass this rule. Write-capable agents fail if the
 * 'tdd-debug' skill is missing from the frontmatter `skills` list.
 * @param {AgentFrontmatter} frontmatter  Parsed agent frontmatter.
 * @returns {TddSkillValidationResult}
 */
export function checkTddSkillRule(frontmatter) {
  const agentName = frontmatter.name ?? '<unknown>';
  if (!isWriteCapable(frontmatter)) {
    return { passed: true, agentName };
  }
  const skills = frontmatter.skills ?? [];
  if (skills.includes('tdd-debug')) {
    return { passed: true, agentName };
  }
  return {
    passed: false,
    agentName,
    violation: `Write-capable agent '${agentName}' must declare 'tdd-debug' as a mandatory skill in frontmatter.`,
  };
}

/**
 * Check whether a list of declared tools satisfies the requirement for a given required tool.
 * Accepts aliases: 'edit/file' and 'create/file' satisfy 'edit';
 * 'run/terminal' and 'execute' satisfy 'execute'.
 * @param {string[]} tools
 * @param {string} requiredTool
 * @returns {boolean}
 */
function toolSatisfied(tools, requiredTool) {
  return tools.some((t) => {
    if (requiredTool === 'edit') {
      return t === 'edit' || t === 'edit/file' || t === 'create/file';
    }
    if (requiredTool === 'execute') {
      return t === 'execute' || t === 'run/terminal';
    }
    return t === requiredTool;
  });
}

// Maps claim type to the required frontmatter tool
/** @type {Record<BodyClaimType, string>} */
const CLAIM_TO_TOOL = {
  'writes-files': 'edit',
  'runs-checks': 'execute',
  'invokes-command': 'execute',
  'read-only': '',
};

/**
 * Validate an agent file: check each body claim against frontmatter tools.
 * A missing frontmatter block is treated as no declared tools (fail-safe).
 * @param {string} filePath
 * @returns {Promise<AgentValidationResult>}
 */
export async function validateAgent(filePath) {
  const content = readTextFileSync(filePath);
  const frontmatter = parseAgentFrontmatter(content);
  const claims = extractBodyClaims(content);
  const normalizedTools = (frontmatter.tools ?? []).map((t) => t.replace(/^['"]|['"]$/g, '').trim());

  /** @type {AgentViolation[]} */
  const violations = [];

  // Dispatcher agents (those declaring the 'agent' tool) are pure coordinators.
  // Their body describes what subagents do, so PROSE runs-checks claims do not
  // imply direct execution capability and the execute requirement is waived.
  //
  // The waiver stops there. It does NOT extend to `invokes-command` — a literal
  // `node …` line is not a description of someone else's work, it is an
  // instruction this agent cannot carry out without `execute`. Waiving that is
  // what let the orchestrator ship ~20 unrunnable commands with a green CI.
  const isDispatcher = normalizedTools.includes('agent');

  for (const claim of claims) {
    const requiredTool = getOwn(CLAIM_TO_TOOL, claim.type);
    if (!requiredTool) continue;
    if (claim.type === 'runs-checks' && isDispatcher) continue;
    if (!toolSatisfied(normalizedTools, requiredTool)) {
      violations.push({
        claim,
        requiredTool,
        message: `Line ${claim.line}: body claims "${claim.excerpt}" (${claim.type}) but frontmatter lacks tool '${requiredTool}'.`,
      });
    }
  }

  // TDD skill rule: write-capable agents must declare tdd-debug as a mandatory skill.
  const tddResult = checkTddSkillRule(frontmatter);
  if (!tddResult.passed) {
    violations.push({
      claim: { type: 'writes-files', line: 1, excerpt: 'frontmatter' },
      requiredTool: 'skills:tdd-debug',
      message: tddResult.violation ?? 'TDD skill rule violated.',
    });
  }

  return { filePath, ok: violations.length === 0, violations };
}
