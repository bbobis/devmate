// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDispatchResult,
  assertFullstackDispatchAllowed,
} from "../lib/workflow/orchestrator.mjs";

/**
 * Build a minimal dispatch result.
 * @param {Partial<Record<string, unknown>>} [overrides]
 * @returns {Record<string, unknown>}
 */
function dispatchResult(overrides = {}) {
  return {
    status: "ok",
    ...overrides,
  };
}

/**
 * Execute a simplified feature-lane flow for regression coverage.
 * @param {Record<string, unknown>|undefined} discovery
 * @param {Record<string, unknown>|undefined} techDesign
 * @param {(name: string) => void} [onGateAdvance]
 * @returns {{ ok: boolean, error?: string }}
 */
function runFeatureLane(discovery, techDesign, onGateAdvance = () => {}) {
  const discoveryCheck = assertDispatchResult("discovery", discovery);
  if (!discoveryCheck.ok) return discoveryCheck;

  onGateAdvance("discovery-done");

  const techDesignCheck = assertDispatchResult("tech-design", techDesign);
  if (!techDesignCheck.ok) return techDesignCheck;

  onGateAdvance("plan-done");
  onGateAdvance("fullstack-dispatch");
  return { ok: true };
}

test("assertDispatchResult / null, empty, and malformed inputs fail closed", () => {
  /** @type {Array<[string, unknown]>} */
  const cases = [
    ["discovery", undefined],
    ["discovery", null],
    ["discovery", ""],
    ["discovery", {}],
    ["discovery", { status: "maybe" }],
  ];

  for (const [agentName, result] of cases) {
    const verdict = assertDispatchResult(agentName, result);
    assert.equal(verdict.ok, false, `${agentName} should reject ${String(result)}`);
    assert.match(verdict.error ?? "", /discovery|status|empty|missing|object/i);
  }
});

test("assertDispatchResult / non-ok status requires reason or error", () => {
  const rejected = assertDispatchResult("planner", dispatchResult({ status: "blocked" }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? "", /planner/i);
  assert.match(rejected.error ?? "", /reason|error/i);

  const allowed = assertDispatchResult(
    "planner",
    dispatchResult({ status: "blocked", reason: "waiting on discovery" }),
  );
  assert.equal(allowed.ok, true);
});

test("assertDispatchResult / artifactPath alone is sufficient for ok results", () => {
  const verdict = assertDispatchResult(
    "tech-design",
    dispatchResult({ status: "ok", artifactPath: ".devmate/session/tech-design.md" }),
  );
  assert.equal(verdict.ok, true);
});

test("assertDispatchResult / per-agent payload fallback works without artifactPath", () => {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const cases = [
    ["discovery", {
      payload: {
        claims: [{ fact: "step 2 dispatches discovery", path: "docs/ARCHITECTURE.md", confidence: "high" }],
        unverified: ["[UNVERIFIED] none"],
      },
    }],
    ["tech-design", { payload: { dataModel: "schema" } }],
    ["planner", { payload: { tasks: ["step 1"] } }],
    ["rubber-duck", { payload: { verdict: "APPROVE_PLAN" } }],
    ["spec-writer", { payload: { specPath: ".devmate/session/spec.md" } }],
    ["ui-ux", { payload: { screens: ["home"] } }],
    ["diagnose", { payload: { bugScope: "backend", reproCommand: "npm test", taskId: "t-001" } }],
    ["security", { payload: { findings: ["none"] } }],
    ["frontend-tester", { payload: { summary: "passed" } }],
    ["fullstack", { payload: { verification: "ok" } }],
  ];

  for (const [agentName, result] of cases) {
    const verdict = assertDispatchResult(agentName, dispatchResult(/** @type {Record<string, unknown>} */ (result)));
    assert.equal(verdict.ok, true, `${agentName} should accept its payload fallback`);
  }
});

test("assertDispatchResult / diagnose requires bugScope, reproCommand, and taskId", () => {
  const partial = assertDispatchResult(
    "diagnose",
    dispatchResult({ payload: { bugScope: "backend" } }),
  );
  assert.equal(partial.ok, false);
  assert.match(partial.error ?? "", /diagnose/i);
  assert.match(partial.error ?? "", /reproCommand|taskId/i);
});

test('assertDispatchResult / security payload without findings is rejected when artifactPath is absent', () => {
  const verdict = assertDispatchResult(
    'security',
    dispatchResult({ payload: { summary: 'review complete' } }),
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? '', /security/i);
  assert.match(verdict.error ?? '', /findings/i);
});

test("assertDispatchResult / unknown agents fail closed", () => {
  const verdict = assertDispatchResult(
    "ghost-agent",
    dispatchResult({ status: "ok", artifactPath: ".devmate/session/ghost.txt" }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /ghost-agent/i);
  assert.match(verdict.error ?? "", /no validator registered/i);
});

test("feature lane / missing discovery halts before fullstack dispatch", () => {
  let fullstackCalls = 0;
  const verdict = runFeatureLane(undefined, dispatchResult({ payload: { dataModel: "schema" } }), () => {
    fullstackCalls += 1;
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /discovery/i);
  assert.equal(fullstackCalls, 0);
});

test("feature lane / empty tech-design result does not advance gates", () => {
  /** @type {string[]} */
  const gates = [];
  const verdict = runFeatureLane(
    dispatchResult({
      payload: {
        claims: [{ fact: "step 2 dispatches discovery", path: "docs/ARCHITECTURE.md", confidence: "high" }],
        unverified: ["[UNVERIFIED] none"],
      },
    }),
    {},
    (gate) => gates.push(gate),
  );

  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /tech-design/i);
  assert.deepEqual(gates, ["discovery-done"]);
});

test("regression / unresolved upstream dispatch never reaches fullstack", () => {
  const upstreamAgents = ["discovery", "tech-design", "planner", "rubber-duck", "spec-writer", "ui-ux", "diagnose", "security", "frontend-tester"];

  for (const agentName of upstreamAgents) {
    let fullstackCalls = 0;
    const verdict = assertDispatchResult(agentName, null);
    if (verdict.ok) {
      fullstackCalls += 1;
    }
    assert.equal(verdict.ok, false, `${agentName} should reject unresolved results`);
    assert.equal(fullstackCalls, 0, `${agentName} must not trigger fullstack`);
  }
});

test("assertFullstackDispatchAllowed / blocks when gate is not impl-started", () => {
  const verdict = assertFullstackDispatchAllowed({
    taskId: "t-1",
    lane: "feature",
    workflowGate: "plan-approved",
    artifactHashes: { spec: ".devmate/session/spec.md", specDigest: "abc" },
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /impl-started/i);
});

test("assertFullstackDispatchAllowed / blocks when spec metadata is missing", () => {
  const verdict = assertFullstackDispatchAllowed({
    taskId: "t-2",
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /spec artifact metadata/i);
});

test("assertFullstackDispatchAllowed / allows dispatch when gate and metadata are present", () => {
  const verdict = assertFullstackDispatchAllowed({
    taskId: "t-3",
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: { spec: ".devmate/session/spec.md", specDigest: "abc" },
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
  });
  assert.equal(verdict.ok, true);
});

test("assertDispatchResult / agentName present in result is accepted", () => {
  const verdict = assertDispatchResult(
    "discovery",
    dispatchResult({
      agentName: "discovery",
      payload: { claims: [{ fact: "f", path: "p", confidence: "high" }], unverified: [] },
    }),
  );
  assert.equal(verdict.ok, true);
});

test("assertDispatchResult / mismatched agentName is rejected", () => {
  const verdict = assertDispatchResult(
    "discovery",
    dispatchResult({
      agentName: "planner",
      payload: { claims: [{ fact: "f", path: "p", confidence: "high" }], unverified: [] },
    }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /discovery/i);
});
