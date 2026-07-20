// @ts-check
// E4-1: OutputContract + budget classifier. Every workflow MUST call
// classifyBudget() and persistBudget() before its first discovery, planning, or
// coding tool call, so token/context limits are enforceable state (TCM-1,
// TCM-11) rather than prompt-prose advice.
import { dirname } from 'node:path';
import {
  ensureDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { tokenBudgetForClass } from './session-budget.mjs';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../types.mjs').OutputContract} OutputContract */

/**
 * Per-class evidence-source cap. The single source of the `maxSources` numbers
 * classifyBudget assigns and the evidence packer (#30) fills to.
 * @type {Record<BudgetClass, number>}
 */
const MAX_SOURCES_BY_CLASS = {
  tiny: 3,
  standard: 10,
  large: 999, // effectively unbounded; ContextReducer (E4-3) / subtractive packing required.
};

/**
 * The token + source budget the evidence packer (#30) consumes for a class,
 * reading both canonical sources — token budget from session-budget's
 * thresholds, source cap from {@link MAX_SOURCES_BY_CLASS} — so nothing is
 * duplicated.
 * @param {BudgetClass} budgetClass
 * @returns {{ maxTokens: number, maxSources: number }}
 */
export function packBudgetForClass(budgetClass) {
  return {
    maxTokens: tokenBudgetForClass(budgetClass),
    maxSources: getOwn(MAX_SOURCES_BY_CLASS, budgetClass) ?? MAX_SOURCES_BY_CLASS.standard,
  };
}

/**
 * Thrown when TaskState cannot be read/parsed during persistBudget. The
 * original file is never modified when this is thrown.
 */
export class StateReadError extends Error {
  /**
   * @param {string} statePath
   * @param {string} detail
   */
  constructor(statePath, detail) {
    super(`Failed to read TaskState at ${statePath}: ${detail}`);
    this.name = 'StateReadError';
    this.statePath = statePath;
  }
}

/**
 * Default evidence requirements per lane.
 * @param {string} lane
 * @returns {string[]}
 */
function evidenceForLane(lane) {
  if (lane === 'bug') return ['stack-trace', 'failing-test', 'touched-files'];
  if (lane === 'feature') return ['spec', 'affected-files'];
  return [];
}

/**
 * Classify a task description into a BudgetClass and build an OutputContract.
 * Pure function — no I/O, same input → same output (modulo created_at).
 * @param {{ lane: string, description?: string, format?: string, audience?: string, done_when?: string, subagents?: boolean, explicitLarge?: boolean }} input
 * @returns {OutputContract}
 */
export function classifyBudget(input) {
  const lane = input.lane;

  /** @type {BudgetClass} */
  let budgetClass;

  if (input.explicitLarge === true) {
    budgetClass = 'large'; // unbounded; ContextReducer (E4-3) required.
  } else if (input.subagents === true) {
    // Subagents always need at least standard budget — overrides tiny lanes.
    budgetClass = 'standard';
  } else if (lane === 'help' || lane === 'learn') {
    budgetClass = 'tiny';
  } else {
    // feature | bug | chore | unknown -> standard
    budgetClass = 'standard';
  }

  const maxSources = getOwn(MAX_SOURCES_BY_CLASS, budgetClass) ?? MAX_SOURCES_BY_CLASS.standard;

  /** @type {'inline'|'pointer'} */
  const citationMode = budgetClass === 'tiny' ? 'inline' : 'pointer';

  return {
    lane,
    format: input.format ?? defaultFormat(lane),
    audience: input.audience ?? 'orchestrator',
    done_when: input.done_when ?? 'Output satisfies the lane contract.',
    evidence_required: evidenceForLane(lane),
    citation_mode: citationMode,
    token_budget_class: budgetClass,
    max_context_sources: maxSources,
    created_at: new Date().toISOString(),
  };
}

/**
 * Default output format for a lane.
 * @param {string} lane
 * @returns {string}
 */
function defaultFormat(lane) {
  if (lane === 'help' || lane === 'learn') return 'answer';
  if (lane === 'rollback') return 'patch';
  return 'pr';
}

/**
 * Persist an OutputContract into TaskState at the given path. Reads current
 * state, validates `schemaVersion`, merges the contract, writes atomically
 * (tmp + rename). Never truncates the original on a read/parse failure.
 * @param {string} taskStatePath
 * @param {OutputContract} contract
 * @returns {Promise<void>}
 */
export async function persistBudget(taskStatePath, contract) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(taskStatePath);
  } catch (/** @type {unknown} */ err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StateReadError(taskStatePath, detail);
  }

  /** @type {any} */
  let state;
  try {
    state = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StateReadError(taskStatePath, `malformed JSON: ${detail}`);
  }

  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new StateReadError(taskStatePath, 'state is not an object');
  }
  if (!('schemaVersion' in state)) {
    throw new StateReadError(taskStatePath, 'missing schemaVersion');
  }

  state.outputContract = contract;

  const tmpPath = taskStatePath + '.tmp';
  await ensureDir(dirname(taskStatePath));
  await writeTextFile(tmpPath, JSON.stringify(state, null, 2));
  await renamePath(tmpPath, taskStatePath);
}

/**
 * Read the OutputContract from TaskState. Returns null if not yet set.
 * @param {string} taskStatePath
 * @returns {Promise<OutputContract|null>}
 */
export async function readBudget(taskStatePath) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(taskStatePath);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  const state = JSON.parse(raw);
  return state.outputContract ?? null;
}
