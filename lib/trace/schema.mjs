// @ts-check

/**
 * E6-1: Pure schema validation for unified trace events.
 *
 * `validateTraceEvent` checks the shared base fields plus the type-specific
 * required fields for each event type. It performs no I/O and is
 * safe to call from anywhere. The single typedef source is `lib/types.mjs`.
 */

import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').TraceEventType} TraceEventType */
/** @typedef {import('../types.mjs').TraceEvent} TraceEvent */
/** @typedef {import('../types.mjs').TraceValidationResult} TraceValidationResult */

/**
 * The valid event type values.
 * Eight base types from E6-1 + three rubber-duck types from E11-3
 * (`grill_complete`, `critique_complete`, `plan_revised`).
 * @type {ReadonlySet<string>}
 */
const VALID_TYPES = new Set([
  'action',
  'gate_transition',
  'loop_attempt',
  'loop_halt',
  'step_complete',
  'fact_write',
  'compaction',
  'budget_warning',
  'grill_complete',
  'critique_complete',
  'plan_revised',
  'spec_revision_requested',
  'no_tdd_override',
  'spec_invalidated',
  'subagent_start',
  'subagent_complete',
  'subagent_reconciled',
  'contract_violation',
  'model_route',
  'discovery_merge',
]);

/**
 * E11-3: Typed error raised by `appendTraceEvent` when an event has a `type`
 * value outside the documented set. Validation failures with a known type
 * surface through the `{ ok: false, errors }` result path; only an unknown
 * type triggers this thrown error.
 */
export class UnknownTraceEventError extends Error {
  /**
   * @param {string} typeValue The unrecognised `type` field value.
   */
  constructor(typeValue) {
    super(
      `Unknown trace event type "${typeValue}". Expected one of: ${[...VALID_TYPES].join(', ')}.`,
    );
    this.name = 'UnknownTraceEventError';
    /** @type {string} */
    this.typeValue = typeValue;
  }
}

/**
 * Returns true iff `type` is a recognised trace event type value.
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownTraceEventType(type) {
  return typeof type === 'string' && VALID_TYPES.has(type);
}

/**
 * Type-specific required fields, keyed by event type. Each entry maps a field
 * name to its expected JavaScript `typeof` (or the literal `'array'`).
 * @type {Record<string, Record<string, 'string'|'number'|'array'>>}
 */
const TYPE_FIELDS = {
  action: { actionType: 'string', path: 'string', digest: 'string' },
  gate_transition: { from: 'string', to: 'string', gate: 'string' },
  loop_attempt: { attempt: 'number', command: 'array', exitCode: 'number', digest: 'string' },
  loop_halt: { reason: 'string', attempt: 'number', last_error: 'string' },
  step_complete: { label: 'string', artifactPaths: 'array' },
  fact_write: { factKey: 'string', scope: 'string', sourcePointer: 'string' },
  compaction: { artifactPath: 'string', entriesBefore: 'number', entriesAfter: 'number' },
  budget_warning: { field: 'string', current: 'number', limit: 'number' },
  grill_complete: {
    assumptions: 'array',
    edgeCases: 'array',
    cornerCases: 'array',
    blockingQuestions: 'array',
  },
  critique_complete: {
    verdict: 'string',
    missingTests: 'array',
    risks: 'array',
    iterationNumber: 'number',
  },
  plan_revised: { revision: 'number', reason: 'string' },
  spec_revision_requested: { feedback: 'string' },
  no_tdd_override: { reason: 'string' },
  spec_invalidated: { reason: 'string' },
  subagent_start: { agentName: 'string', persona: 'string', activeCount: 'number' },
  subagent_complete: { agentName: 'string', persona: 'string', durationMs: 'number', activeCount: 'number' },
  subagent_reconciled: { previous: 'number' },
  contract_violation: { contract: 'string', path: 'string', errors: 'array' },
  model_route: { budgetClass: 'string', modelId: 'string', mode: 'string' },
  discovery_merge: { inputs: 'number', merged: 'number', dropped: 'number', conflicts: 'number' },
};

/**
 * Optional per-type fields, validated only when present on the event.
 * E10-03: human-gate transitions carry an `actor` + `evidence` audit pair;
 * internal/auto gate transitions omit both and stay valid unchanged.
 * @type {Record<string, Record<string, 'string'|'number'|'array'>>}
 */
const OPTIONAL_TYPE_FIELDS = {
  gate_transition: { actor: 'string', evidence: 'string' },
};

/**
 * Check that `value` matches the expected kind.
 * @param {unknown} value
 * @param {'string'|'number'|'array'} kind
 * @returns {boolean}
 */
function matchesKind(value, kind) {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

/**
 * Validate a trace event against its type schema.
 * Pure function — no I/O.
 * @param {unknown} event
 * @returns {TraceValidationResult}
 */
export function validateTraceEvent(event) {
  /** @type {string[]} */
  const errors = [];

  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return { ok: false, errors: ['event must be a non-null object'] };
  }

  const ev = /** @type {Record<string, unknown>} */ (event);

  // Base required fields.
  if (typeof ev.type !== 'string' || !VALID_TYPES.has(ev.type)) {
    errors.push(`type must be one of: ${[...VALID_TYPES].join(', ')}`);
    // Without a valid type we cannot check type-specific fields; report base only.
  }
  if (typeof ev.stepId !== 'string' || ev.stepId.length === 0) {
    errors.push('stepId is required and must be a non-empty string');
  }
  if (typeof ev.taskId !== 'string' || ev.taskId.length === 0) {
    errors.push('taskId is required and must be a non-empty string');
  } else if (ev.taskId === 'unknown') {
    // Belt-and-braces for #76: 'unknown' was the parser fallback for a taskId
    // field no host actually sends, and it minted a junk unknown.jsonl trace
    // file no reader ever consults. A writer with no real task must SKIP the
    // append, not launder a sentinel through it — rejecting the sentinel here
    // makes that unrepresentable at the last line of defense.
    errors.push(
      "taskId 'unknown' is a parser-fallback sentinel, not a task — derive the id from task.json or skip the trace append",
    );
  }
  if (typeof ev.ts !== 'string' || ev.ts.length === 0) {
    errors.push('ts is required and must be a non-empty ISO-8601 string');
  }
  if (typeof ev.schemaVersion !== 'number' || !Number.isFinite(ev.schemaVersion)) {
    errors.push('schemaVersion is required and must be a number');
  }

  // Type-specific required fields (only when type is valid).
  if (typeof ev.type === 'string' && VALID_TYPES.has(ev.type)) {
    const spec = getOwn(TYPE_FIELDS, ev.type) ?? {};
    for (const [field, kind] of Object.entries(spec)) {
      if (!(field in ev) || !matchesKind(ev[field], kind)) {
        errors.push(`${ev.type} requires field "${field}" of type ${kind}`);
      }
    }
    // Optional fields are validated only when present.
    const optional = getOwn(OPTIONAL_TYPE_FIELDS, ev.type);
    if (optional !== undefined) {
      for (const [field, kind] of Object.entries(optional)) {
        if (field in ev && !matchesKind(ev[field], kind)) {
          errors.push(`${ev.type} optional field "${field}" must be of type ${kind} when present`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
