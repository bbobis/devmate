// @ts-check
/**
 * The gate → may-I-edit-source policy, and nothing else.
 *
 * This lived in `lib/gate-guard.mjs` (#91), which reads the filesystem and
 * imports `lib/workflow/`. `lib/gate-guard-core.mjs` — the PURE evaluator the
 * PreToolUse hook actually runs — deliberately has no imports at all, so it
 * could not reach the policy without dragging disk I/O into a function
 * documented as "Pure — no disk I/O", or risking the import cycle its Rule 6
 * comment already avoids.
 *
 * The consequence of that gap was the defect: the core hard-coded a single gate
 * string (`plan-approved`) and defaulted to allow, while the real allowlist sat
 * here, correct, fully unit-tested, and imported by nothing but its own test.
 *
 * Zero imports, on purpose. Both modules depend on this one; it depends on
 * nobody, so there is exactly one definition of when source may be edited.
 */

/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */

/**
 * Gates at or after which source edits are permitted. Edits are blocked at every
 * earlier gate — including `no-lane`, `spec-draft`, and `spec-approved` (a spec
 * that is approved but whose implementation has not been started).
 * @type {readonly WorkflowGate[]}
 */
export const IMPL_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (['impl-started', 'verification-passed', 'pr-ready', 'done']),
);

/**
 * Check whether source edits are allowed at the given workflow gate.
 * Fail-closed: an unknown gate is not in the allowlist, so it denies.
 *
 * @param {WorkflowGate} gate  Current workflow gate.
 * @returns {boolean}  True when editing is allowed.
 */
export function isEditAllowedAtGate(gate) {
  return IMPL_GATES.includes(gate);
}
