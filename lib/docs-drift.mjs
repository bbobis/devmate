// @ts-check
import { readTextFile } from './fs-safe.mjs';
import { OFFICIAL_HOOK_EVENTS } from './hooks/registry.mjs';
import { flattenTransitions } from './gate-transitions.mjs';

/** @typedef {import('./types.mjs').DocsClaim} DocsClaim */
/** @typedef {import('./types.mjs').DocsClaimType} DocsClaimType */
/** @typedef {import('./types.mjs').DriftViolation} DriftViolation */

/**
 * Matches a backtick-delimited inline code span, capturing its inner text.
 * Global so we can iterate every span on a line.
 */
const CODE_SPAN_RE = /`([^`]+)`/g;

/**
 * Returns true when a token is strictly alphanumeric.
 * @param {string} value
 * @returns {boolean}
 */
function isAlphaNumeric(value) {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isLower && !isDigit) return false;
  }
  return value.length > 0;
}

/**
 * Check PascalCase shape without regex.
 * @param {string} word
 * @returns {boolean}
 */
function isPascalCase(word) {
  if (!isAlphaNumeric(word)) return false;
  const first = word[0];
  if (first === undefined || first < 'A' || first > 'Z') return false;
  return word !== word.toUpperCase();
}

/**
 * Check camelCase shape without regex.
 * @param {string} token
 * @returns {boolean}
 */
function isCamelCase(token) {
  if (!isAlphaNumeric(token)) return false;
  const first = token[0];
  if (first === undefined || first < 'a' || first > 'z') return false;
  for (let i = 1; i < token.length; i++) {
    const ch = token[i];
    if (ch >= 'A' && ch <= 'Z') return true;
  }
  return false;
}

/**
 * Matches a numeric count like `7 scripts` or `3 agents` (the noun is captured
 * only to confirm the pattern; the count value itself is what we record).
 */
const COUNT_RE = /\b(\d+)\s+(scripts?|agents?|hooks?|commands?|skills?)\b/gi;

/**
 * Non-gate progress markers E9-14 deliberately kept as prose milestones (or
 * result-status values, e.g. `escalated`). When one of these appears on a line
 * that explicitly calls it a milestone, it is not treated as a gate claim —
 * the allowlist-of-known-milestones escape from E9-04.
 * @type {readonly string[]}
 */
export const KNOWN_NON_GATE_MILESTONES = Object.freeze([
  'intake',
  'design-done',
  'backend-ready',
  'diagnosis-done',
  'scope-written',
  'change-complete',
  'escalated',
]);

/**
 * Check kebab-case shape (lowercase alphanumeric segments joined by single
 * hyphens, at least two segments) without heavy regex.
 * @param {string} token
 * @returns {boolean}
 */
function isKebabCase(token) {
  if (!token.includes('-')) return false;
  const segments = token.split('-');
  for (const seg of segments) {
    if (seg.length === 0) return false;
    for (const ch of seg) {
      const isLower = ch >= 'a' && ch <= 'z';
      const isDigit = ch >= '0' && ch <= '9';
      if (!isLower && !isDigit) return false;
    }
  }
  const first = token[0];
  return first !== undefined && first >= 'a' && first <= 'z';
}

/**
 * Does a markdown table header row open a gate table (first cell is "Gate")?
 * @param {string} line
 * @returns {boolean}
 */
function isGateTableHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return false;
  const firstCell = trimmed.split('|')[1];
  return firstCell !== undefined && firstCell.trim().toLowerCase() === 'gate';
}

/**
 * Extract gate-name claims with line numbers from full document text.
 * Conservative gate contexts only (to avoid flagging arbitrary kebab-case):
 *  - the first backticked token of a row in a table whose header cell is
 *    "Gate" (the gate-map tables);
 *  - a backticked kebab-case token directly adjacent to the word "gate"
 *    (e.g. "advance the `lane-set` gate", "[INTERNAL GATE] `grill-done`");
 *  - any backticked kebab-case token on a line that mentions `workflowGate`.
 * Tokens from {@link KNOWN_NON_GATE_MILESTONES} are skipped when the line
 * explicitly reclassifies them (mentions "milestone" or "not a workflowGate").
 * @param {string} text
 * @returns {Array<{ value: string, line: number }>}
 */
function gateClaimEntries(text) {
  const lines = text.split(/\r?\n/);
  /** @type {Array<{ value: string, line: number }>} */
  const entries = [];
  let inGateTable = false;

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const trimmed = line.trim();

    if (isGateTableHeader(line)) {
      inGateTable = true;
      return;
    }
    if (inGateTable && !trimmed.startsWith('|')) {
      inGateTable = false;
    }

    const isMilestoneLine = /milestone|not a workflowgate|not `workflowgate`/i.test(line);

    /** @type {Set<string>} */
    const found = new Set();

    if (inGateTable && trimmed.startsWith('|')) {
      const firstCell = trimmed.split('|')[1] ?? '';
      CODE_SPAN_RE.lastIndex = 0;
      const span = CODE_SPAN_RE.exec(firstCell);
      const inner = span?.[1]?.trim();
      if (inner !== undefined && isKebabCase(inner)) found.add(inner);
    }

    // Adjacency: `token` gate / gate `token` / GATE] `token`.
    for (const re of [
      /`([^`]+)`\s+gate\b/gi,
      /\bgate\s+`([^`]+)`/gi,
      /GATE\]\s*`([^`]+)`/g,
    ]) {
      /** @type {RegExpExecArray|null} */
      let m;
      while ((m = re.exec(line)) !== null) {
        const inner = m[1]?.trim();
        if (inner !== undefined && isKebabCase(inner)) found.add(inner);
      }
    }

    // Lines that reference workflowGate list gate values.
    if (/workflowGate/.test(line)) {
      CODE_SPAN_RE.lastIndex = 0;
      /** @type {RegExpExecArray|null} */
      let span;
      while ((span = CODE_SPAN_RE.exec(line)) !== null) {
        const inner = span[1]?.trim();
        if (inner !== undefined && isKebabCase(inner)) found.add(inner);
      }
    }

    for (const value of found) {
      if (isMilestoneLine && KNOWN_NON_GATE_MILESTONES.includes(value)) continue;
      entries.push({ value, line: lineNumber });
    }
  });

  return entries;
}

/**
 * Extract gate-like tokens (kebab-case in backticks or gate tables) from doc text.
 * @param {string} text
 * @returns {string[]}  candidate gate names
 */
export function extractGateClaims(text) {
  return [...new Set(gateClaimEntries(text).map((e) => e.value))];
}

/**
 * Classify a code-span token into a recognized claim type, or null if it is
 * not a recognized platform-claim pattern.
 * @param {string} token
 * @returns {DocsClaimType|null}
 */
function classifyCodeSpan(token) {
  const trimmed = token.trim();
  if (isPascalCase(trimmed)) return 'hook-event';
  if (isCamelCase(trimmed)) return 'config-key';
  return null;
}

/**
 * Extract typed claims from a markdown or JSON docs file.
 * Recognized patterns:
 *  - backtick code spans that look like a hook event (PascalCase) or a
 *    config key (camelCase);
 *  - numeric counts on lines like `N scripts` or `N agents`.
 * Inline code that is neither PascalCase nor camelCase (e.g. file paths,
 * shell commands) is ignored.
 * Gate-name claims (kebab-case tokens in a gate context, see
 * {@link extractGateClaims}) are always extracted as claimType `gate-name`.
 * Pass `opts.claimTypes` to restrict which claim types are returned (e.g.
 * `['gate-name']` for prose-heavy docs where identifier checks would
 * false-positive).
 * @param {string} filePath
 * @param {{ claimTypes?: DocsClaimType[] }} [opts]
 * @returns {Promise<DocsClaim[]>}
 */
export async function extractDocsClaims(filePath, opts = {}) {
  const raw = await readTextFile(filePath);
  const lines = raw.split(/\r?\n/);

  /** @type {DocsClaim[]} */
  const claims = [];

  for (const entry of gateClaimEntries(raw)) {
    claims.push({ file: filePath, line: entry.line, claimType: 'gate-name', value: entry.value });
  }

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;

    // Code spans → hook-event / config-key.
    CODE_SPAN_RE.lastIndex = 0;
    /** @type {RegExpExecArray|null} */
    let span;
    while ((span = CODE_SPAN_RE.exec(line)) !== null) {
      const inner = span[1];
      if (inner === undefined) continue;
      const claimType = classifyCodeSpan(inner);
      if (claimType !== null) {
        claims.push({ file: filePath, line: lineNumber, claimType, value: inner.trim() });
      }
    }

    // Numeric counts → count.
    COUNT_RE.lastIndex = 0;
    /** @type {RegExpExecArray|null} */
    let count;
    while ((count = COUNT_RE.exec(line)) !== null) {
      const value = count[1];
      if (value === undefined) continue;
      claims.push({ file: filePath, line: lineNumber, claimType: 'count', value });
    }
  });

  if (opts.claimTypes !== undefined) {
    const wanted = new Set(opts.claimTypes);
    return claims.filter((c) => wanted.has(c.claimType));
  }
  return claims;
}

/**
 * The allowed `Enforcement:` vocabulary (fixed by E9-26; machine-checked by
 * the E9-30 honesty pass).
 * @type {readonly string[]}
 */
export const ENFORCEMENT_LEVELS = Object.freeze([
  'structural',
  'ci-enforced',
  'hook-runtime',
  'prompt-only',
  'aspirational',
]);

/** Matches a pattern heading (`### TCM-1 — …` / `### P8 — …`), capturing the id. */
const PATTERN_HEADING_RE = /^### ((?:TCM-|P)\d+)\b/;

/**
 * Matches an Enforcement line: `- **Enforcement:** \`level\` (\`file:line\`) — …`.
 * Level and pointer are captured loosely so the validator (not the extractor)
 * reports vocabulary/pointer problems. Split into two single-purpose regexes
 * (no optional quantified groups → no backtracking blowup).
 */
const ENFORCEMENT_LEVEL_RE = /^- \*\*Enforcement:\*\* `([^`]*)`/;
const ENFORCEMENT_POINTER_RE = /\(`([^`]*)`\)/;

/**
 * Matches any space-free backticked token; the caller strips an optional
 * `:line` suffix and filters to path-ish extensions in plain code (keeps the
 * regex linear — no optional quantified suffix group).
 */
const BACKTICK_SPAN_RE = /`([^`\s]+)`/g;

/** File extensions that count as wiring evidence in an Enforcement line. */
const PATH_TOKEN_EXTS = Object.freeze(['.mjs', '.json', '.yml', '.yaml']);

/**
 * Extract pattern enforcement claims from PATTERNS.md.
 *
 * One claim per `### TCM-n / ### Pn` pattern block. A block whose Enforcement
 * line is missing yields a claim with empty `level`/`pointer` anchored at the
 * heading, so the validator can flag it. `text` carries the full Enforcement
 * line for the wiring cross-check (a claim may cite more files than its
 * primary pointer).
 * @param {string} patternsText
 * @returns {Array<{ pattern: string, level: string, pointer: string, line: number, text: string }>}
 */
export function extractEnforcementClaims(patternsText) {
  const lines = patternsText.split(/\r?\n/);
  /** @type {Array<{ pattern: string, level: string, pointer: string, line: number, text: string }>} */
  const claims = [];
  /** @type {{ id: string, line: number, found: boolean }|null} */
  let current = null;

  const flushMissing = () => {
    if (current !== null && !current.found) {
      claims.push({ pattern: current.id, level: '', pointer: '', line: current.line, text: '' });
    }
  };

  lines.forEach((line, idx) => {
    const heading = PATTERN_HEADING_RE.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      flushMissing();
      current = { id: heading[1], line: idx + 1, found: false };
      return;
    }
    if (current === null) return;
    if (line.startsWith('- **Enforcement:**')) {
      current.found = true;
      const level = ENFORCEMENT_LEVEL_RE.exec(line);
      const pointer = ENFORCEMENT_POINTER_RE.exec(line);
      claims.push({
        pattern: current.id,
        level: (level?.[1] ?? '').trim(),
        pointer: (pointer?.[1] ?? '').trim(),
        line: idx + 1,
        text: line,
      });
    }
  });
  flushMissing();

  return claims;
}

/**
 * Validate enforcement claims (E9-30): vocabulary, `file:line` pointer, and —
 * for the machine-checkable levels — a wiring cross-check:
 *
 *  - `ci-enforced` must reference at least one file that is actually in the
 *    CI path: the workflow file itself, a `*.test.mjs` (run by `npm test`
 *    inside `verify`), or a script whose basename appears in the workflow
 *    text (direct `node scripts/x.mjs` or `npm run x` steps).
 *  - `hook-runtime` must reference the hook manifest itself or a file whose
 *    basename appears in `hooks/hooks.json`.
 *
 * Deliberately conservative (only machine-verifiable contradictions fail):
 * `structural` / `prompt-only` / `aspirational` make no wiring claim and are
 * only vocabulary/pointer-checked.
 * @param {ReturnType<typeof extractEnforcementClaims>} claims
 * @param {{ ciText: string, hooksText: string, patternsFile?: string }} truth
 * @returns {DriftViolation[]}
 */
export function validateEnforcementClaims(claims, truth) {
  /** @type {DriftViolation[]} */
  const violations = [];
  const file = truth.patternsFile ?? 'docs/PATTERNS.md';

  /** @param {typeof claims[number]} claim @param {string} reason */
  const flag = (claim, reason) => {
    violations.push({
      claim: {
        file,
        line: claim.line,
        claimType: 'enforcement',
        value: `${claim.pattern}: ${claim.level || '(missing)'}`,
      },
      reason,
    });
  };

  /** @param {string} text @returns {Array<{ path: string, base: string }>} */
  const pathTokens = (text) => {
    /** @type {Array<{ path: string, base: string }>} */
    const tokens = [];
    BACKTICK_SPAN_RE.lastIndex = 0;
    /** @type {RegExpExecArray|null} */
    let m;
    while ((m = BACKTICK_SPAN_RE.exec(text)) !== null) {
      const raw = m[1];
      if (raw === undefined) continue;
      // Strip an optional trailing :line suffix in plain code.
      const colon = raw.lastIndexOf(':');
      const path =
        colon > 0 && /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw;
      if (!PATH_TOKEN_EXTS.some((ext) => path.endsWith(ext))) continue;
      tokens.push({ path, base: path.split('/').pop() ?? path });
    }
    return tokens;
  };

  for (const claim of claims) {
    if (claim.level === '' && claim.text === '') {
      flag(claim, 'pattern block has no Enforcement line (required by E9-26).');
      continue;
    }
    if (!ENFORCEMENT_LEVELS.includes(claim.level)) {
      flag(
        claim,
        `enforcement level "${claim.level}" is not in the vocabulary [${ENFORCEMENT_LEVELS.join(', ')}].`
      );
      continue;
    }
    if (!/^[^\s:`]+:\d+$/.test(claim.pointer)) {
      flag(claim, 'Enforcement line must carry a `file:line` evidence pointer.');
      continue;
    }

    const tokens = pathTokens(claim.text);
    if (claim.level === 'ci-enforced') {
      const wired = tokens.some(
        (t) =>
          t.base === 'ci.yml' ||
          t.path.endsWith('.test.mjs') ||
          truth.ciText.includes(t.base.replace(/\.mjs$/, ''))
      );
      if (!wired) {
        flag(
          claim,
          'claims ci-enforced but none of the referenced files appear in .github/workflows/ci.yml (or run under npm test).'
        );
      }
    } else if (claim.level === 'hook-runtime') {
      const wired = tokens.some(
        (t) => t.base === 'hooks.json' || truth.hooksText.includes(t.base)
      );
      if (!wired) {
        flag(
          claim,
          'claims hook-runtime but none of the referenced files are registered in hooks/hooks.json.'
        );
      }
    }
  }

  return violations;
}

/**
 * Diff extracted docs claims against a ground truth map.
 * For each claim whose `claimType` is present in the ground truth map, the
 * claim's `value` must be in the allowed set, otherwise it is a violation.
 * Claims whose type is not in the map pass through without error.
 * @param {DocsClaim[]} docsClaims
 * @param {Map<string, string[]>} groundTruth   claimType → allowed values.
 * @returns {DriftViolation[]}
 */
export function diffClaims(docsClaims, groundTruth) {
  /** @type {DriftViolation[]} */
  const violations = [];

  for (const claim of docsClaims) {
    const allowed = groundTruth.get(claim.claimType);
    // Unknown claim type for this ground truth: pass through.
    if (allowed === undefined) continue;
    if (!allowed.includes(claim.value)) {
      violations.push({
        claim,
        reason:
          `${claim.claimType} "${claim.value}" is not in the verified set ` +
          `[${allowed.join(', ')}].`,
      });
    }
  }

  return violations;
}

/**
 * Read and JSON-parse a file, returning null if it does not exist or is
 * unreadable. Other (parse) errors are rethrown.
 * @param {string} filePath
 * @returns {Promise<unknown|null>}
 */
async function readJsonOrNull(filePath) {
  let raw;
  try {
    raw = await readTextFile(filePath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Build a ground truth map from a hooks manifest, a config schema, and an
 * optional state schema. Sources that are absent are skipped (no entry added),
 * so callers can run before later epics land their schemas.
 *
 *  - hook-event: the union of the official VS Code event vocabulary and the
 *    top-level event-name keys of the hooks manifest's `hooks` object. Docs may
 *    legitimately reference any official event name; only invented/misspelled
 *    event names (not in the official set) are drift.
 *  - config-key: the keys of the config schema's `properties` object, if the
 *    file exists.
 *  - state-name: the keys of the state schema's `states` object, if a state
 *    schema path is given and the file exists.
 * @param {{ hooksPath: string, configSchemaPath: string, stateSchemaPath?: string }} sources
 * @returns {Promise<Map<string, string[]>>}
 */
export async function buildGroundTruth(sources) {
  /** @type {Map<string, string[]>} */
  const map = new Map();

  // hook-event names: official VS Code vocabulary unioned with whatever the
  // manifest registers (the manifest is a subset of the official set).
  /** @type {Set<string>} */
  const hookEvents = new Set(OFFICIAL_HOOK_EVENTS);
  const manifest = await readJsonOrNull(sources.hooksPath);
  if (manifest !== null && typeof manifest === 'object') {
    const m = /** @type {Record<string, unknown>} */ (manifest);
    const hooks = m['hooks'];
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
      for (const key of Object.keys(/** @type {Record<string, unknown>} */ (hooks))) {
        hookEvents.add(key);
      }
    }
  }
  map.set('hook-event', [...hookEvents]);

  // gate-name ground truth: the keys of the canonical flattened transition
  // table, which exhaustively cover VALID_GATES (lib/task-state.mjs).
  map.set('gate-name', Object.keys(flattenTransitions()));

  // config-key names from the config schema (skip if the file is absent).
  const configSchema = await readJsonOrNull(sources.configSchemaPath);
  if (configSchema !== null && typeof configSchema === 'object') {
    const c = /** @type {Record<string, unknown>} */ (configSchema);
    const properties = c['properties'];
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      map.set('config-key', Object.keys(/** @type {Record<string, unknown>} */ (properties)));
    }
  }

  // state-name names from the state schema (skip if not yet landed).
  if (sources.stateSchemaPath !== undefined) {
    const stateSchema = await readJsonOrNull(sources.stateSchemaPath);
    if (stateSchema !== null && typeof stateSchema === 'object') {
      const s = /** @type {Record<string, unknown>} */ (stateSchema);
      const states = s['states'];
      if (states !== null && typeof states === 'object' && !Array.isArray(states)) {
        map.set('state-name', Object.keys(/** @type {Record<string, unknown>} */ (states)));
      }
    }
  }

  return map;
}
