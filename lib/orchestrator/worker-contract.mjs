// @ts-check
/**
 * E8-1: orchestrator-side worker-contract surface.
 *
 * The canonical WorkerReturn validator already exists from E4-8 (#38) at
 * `lib/context/worker-contract.mjs`. To avoid drift, this module re-exports that
 * single source of truth rather than re-implementing the checks. The orchestrator
 * imports `validateWorkerReturn` from here so the fanout layer has one stable
 * import path while the validation logic stays defined in exactly one place.
 *
 * Source of truth: #38 (E4-8), lib/context/worker-contract.mjs — do not diverge.
 */

export {
  validateWorkerReturn,
  serializeWorkerReturn,
  WorkerContractError,
  WorkerReturnBuilder,
} from '../context/worker-contract.mjs';
