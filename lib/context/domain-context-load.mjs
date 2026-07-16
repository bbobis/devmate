// @ts-check
// DN-3: budgeted per-domain context loading for worker dispatch. Resolves the
// contextFile pointers advertised by the DN-2 state file
// (.devmate/state/domain-context.json) into dispatch-ready entries, capped by
// the repo's single token estimator (E9-09 — do NOT add another estimator).
// The cap is elastic and LOUD: full content only when it fits the budget,
// otherwise a digest + explicit pointer — never a silent large paste (TCM-9).
// Missing files never throw: the entry is marked missing and dispatch
// proceeds (fail-open), mirroring loadPersonaInstructions.

import { isAbsolute, resolve } from 'node:path';
import { estimateTokens } from './estimate-tokens.mjs';
import { DOMAIN_MATCH_TOP_N } from './domain-resolver.mjs';

/** @typedef {import('../types.mjs').DomainConfig} DomainConfig */
/** @typedef {import('../types.mjs').DomainContextState} DomainContextState */
/** @typedef {import('../types.mjs').DomainDispatchContext} DomainDispatchContext */

/**
 * Total token budget for the domain-context dispatch section across ALL
 * domains combined (both, at the current DOMAIN_MATCH_TOP_N of 2).
 */
// TODO: calibrate — provisional placeholder (token-budget evals #55 / E7-5 can measure real dispatch sizes)
export const DOMAIN_CONTEXT_MAX_TOKENS = 1500;

/** Content lines kept in the digest fallback for an over-budget context file. */
// TODO: calibrate — provisional placeholder (same evals as DOMAIN_CONTEXT_MAX_TOKENS)
const DIGEST_HEAD_LINES = 10;

/**
 * Per-domain allowance reserved for the rendered headers and framing lines
 * (domain heading, globs, related-domain and pointer lines), so the whole
 * rendered section — not just the file contents — stays under the budget.
 */
// TODO: calibrate — provisional placeholder
const RENDER_OVERHEAD_TOKENS = 40;

/**
 * Markdown heading list of a context file — the map a worker uses to decide
 * whether the full file is worth a read once the digest fallback fires.
 * @param {string[]} lines
 * @returns {string}
 */
function headingList(lines) {
  const headings = lines
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.trim());
  return headings.length > 0 ? `Headings: ${headings.join(' | ')}` : '';
}

/**
 * Loud digest fallback for an over-budget context file: the first
 * DIGEST_HEAD_LINES lines plus the file's heading list.
 * @param {string} content
 * @returns {string}
 */
function buildDigest(content) {
  const lines = content.split(/\r?\n/);
  const head = lines.slice(0, DIGEST_HEAD_LINES).join('\n').trimEnd();
  const headings = headingList(lines);
  return [head, headings].filter((part) => part !== '').join('\n');
}

/**
 * Load and budget per-domain context for a dispatch.
 * Never throws on missing files — marks the entry missing and continues (fail-open).
 *
 * @param {Object} input
 * @param {string} input.repoRoot
 * @param {import('../types.mjs').DomainContextState} input.state   Parsed domain-context.json.
 * @param {number} input.maxTokens   Total budget across all domains for this section.
 * @param {(p: string) => string|null} input.readFile   Injected reader (null = missing).
 * @returns {import('../types.mjs').DomainDispatchContext[]}
 */
export function loadDomainContextForDispatch(input) {
  const matches = Array.isArray(input.state?.matches) ? input.state.matches : [];
  if (matches.length === 0) return [];

  // The DN-2 writer already caps the state file at DOMAIN_MATCH_TOP_N; the
  // slice is a defensive re-cap so a hand-edited state file cannot blow the
  // dispatch budget by sheer entry count.
  const ranked = matches.slice(0, DOMAIN_MATCH_TOP_N);

  // Resolve and read every ranked context file up front (bounded by the
  // TOP_N re-cap above), so the budgeting loop below never allocates.
  const loaded = ranked.map((match) => {
    const contextFile =
      typeof match.contextFile === 'string' && match.contextFile.trim() !== ''
        ? match.contextFile
        : null;
    if (contextFile === null) return { match, contextFile, content: null };
    const fullPath = isAbsolute(contextFile) ? contextFile : resolve(input.repoRoot, contextFile);
    try {
      return { match, contextFile, content: input.readFile(fullPath) };
    } catch {
      return { match, contextFile, content: null }; // a throwing reader == a missing file
    }
  });

  let remaining = Number.isFinite(input.maxTokens) ? Math.max(0, input.maxTokens) : 0;

  /** @type {DomainDispatchContext[]} */
  const entries = [];
  for (const { match, contextFile, content } of loaded) {
    const base = {
      domain: match.domain,
      globs: Array.isArray(match.matchedGlobs) ? match.matchedGlobs : [],
      relatedDomains: Array.isArray(match.relatedDomains) ? match.relatedDomains : [],
      contextFile,
    };

    remaining = Math.max(0, remaining - RENDER_OVERHEAD_TOKENS);

    if (content === null) {
      entries.push({ ...base, content: null, digest: null, truncated: false, missing: true });
      continue;
    }

    const cost = estimateTokens(content);
    if (cost <= remaining) {
      remaining -= cost;
      entries.push({ ...base, content, digest: null, truncated: false, missing: false });
      continue;
    }

    // Over budget: degrade loudly to digest + pointer, in rank order — the
    // first domain gets budget priority, later ones absorb the truncation.
    let digest = buildDigest(content);
    if (estimateTokens(digest) > remaining) {
      const headingsOnly = headingList(content.split(/\r?\n/));
      digest = estimateTokens(headingsOnly) <= remaining ? headingsOnly : '';
    }
    remaining = Math.max(0, remaining - estimateTokens(digest));
    entries.push({ ...base, content: null, digest, truncated: true, missing: false });
  }
  return entries;
}

/**
 * Result of validating declared domain context files at session start.
 * @typedef {Object} DomainContextFileCheckResult
 * @property {string[]} missing  One `<domain id> (<contextFile>)` entry per declared-but-missing file.
 * @property {string[]} present  Domain ids whose declared contextFile resolved on disk.
 */

/**
 * Synchronously check whether each domain's declared `contextFile` exists on
 * disk. Domains with a null or omitted `contextFile` are skipped entirely.
 * Used by `session-start.mjs` to emit a non-blocking warning, mirroring
 * `checkPersonaInstructionFiles` (lib/persona-instructions.mjs).
 *
 * @param {string} repoRoot     Absolute path to the repo root.
 * @param {DomainConfig[]} domains
 * @param {(path: string) => boolean} existsFn  Injectable existence check (defaults wired by caller).
 * @returns {DomainContextFileCheckResult}
 */
export function checkDomainContextFiles(repoRoot, domains, existsFn) {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const present = [];
  for (const domain of domains) {
    const rel = domain?.contextFile;
    if (typeof rel !== 'string' || rel.trim() === '') {
      continue;
    }
    const fullPath = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
    if (existsFn(fullPath)) {
      present.push(domain.domain);
    } else {
      missing.push(`${domain.domain} (${rel})`);
    }
  }
  return { missing, present };
}
