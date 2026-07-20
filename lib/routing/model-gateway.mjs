// @ts-check
// E16-6 (R6): the model-gateway seam.
//
// Huyen (AI Engineering, ch10): a MODEL GATEWAY centralizes model access so
// cross-cutting concerns — provider failover, cost caps, rate limits — live in ONE
// place instead of at every call site. devmate has none today. This is the seam:
// an interface plus a default PASS-THROUGH implementation that records the chosen
// cost tier and invokes the call unchanged. A future failover gateway replaces
// exactly this one object; no call site changes.
//
// The gateway does NOT select or fail over between models here — that is platform
// dependent and unverified ([UNVERIFIED]); the default is a recording pass-through.

/**
 * @typedef {{ tier: 'cheap'|'powerful', reason: string }} ModelTierRequest
 */

/**
 * @typedef {Object} ModelGateway
 * @property {<T>(request: ModelTierRequest, call: () => T) => T} route
 *   Route a model call through the gateway: record the chosen tier, then invoke
 *   `call` and return its result. The single seam a failover impl replaces.
 */

/**
 * The default pass-through gateway: records the chosen tier (via an injected
 * `record` sink — telemetry by default is a no-op) and invokes the call unchanged.
 * Pure aside from the injected sink; no I/O of its own, no model selection.
 * @param {{ record?: (entry: ModelTierRequest) => void }} [opts]
 * @returns {ModelGateway}
 */
export function createPassThroughGateway(opts = {}) {
  const record = typeof opts.record === 'function' ? opts.record : () => {};
  return {
    route(request, call) {
      record({ tier: request.tier, reason: request.reason });
      return call();
    },
  };
}
