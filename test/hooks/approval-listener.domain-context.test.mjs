// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { handleUserPromptSubmit } from "../../hooks/approval-listener.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/** A config whose domains section matches the DN-1 example in docs/config.md. */
const DOMAINS_SECTION = [
  {
    domain: "billing",
    keywords: ["invoice", "payment", "refund", "charge"],
    globs: ["packages/billing/src/**"],
    contextFile: ".devmate/contexts/billing.md",
    relatedDomains: ["orders"],
  },
  {
    domain: "orders",
    keywords: ["order", "fulfillment"],
    globs: ["packages/orders/src/**"],
  },
];

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "feat-201",
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp repo root with a devmate config and optional task.json.
 * @param {{ domains?: unknown, rawConfig?: string, state?: TaskState|null }} [opts]
 * @returns {{ root: string, statePath: string, contextPath: string, cleanup: () => void }}
 */
function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "devmate-domain-ctx-"));
  const stateDir = join(root, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });

  const configPath = join(root, ".devmate", "devmate.config.json");
  if (opts.rawConfig !== undefined) {
    writeFileSync(configPath, opts.rawConfig, "utf8");
  } else {
    /** @type {Record<string, unknown>} */
    const config = {
      schemaVersion: 1,
      personas: [{ persona: "backend", editableGlobs: ["lib/**"] }],
    };
    if (opts.domains !== undefined) config.domains = opts.domains;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  }

  const statePath = join(stateDir, "task.json");
  const state = opts.state === undefined ? makeState() : opts.state;
  if (state !== null) {
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  return {
    root,
    statePath,
    contextPath: join(stateDir, "domain-context.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} root @param {string} prompt */
async function runHook(root, prompt) {
  return handleUserPromptSubmit({
    prompt,
    root,
    stdout: /** @type {NodeJS.WritableStream} */ (new PassThrough()),
  });
}

test("domain-context › domains config + prompt writes ranked matches with the expected shape", async () => {
  const fx = makeFixture({
    domains: DOMAINS_SECTION,
    state: makeState({ specFiles: ["packages/billing/src/checkout.ts"] }),
  });
  try {
    const result = await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.equal(result.action, "passthrough");
    assert.ok(existsSync(fx.contextPath), "domain-context.json must be written");
    const summary = JSON.parse(readFileSync(fx.contextPath, "utf8"));
    assert.equal(summary.schemaVersion, 1);
    assert.equal(typeof summary.resolvedAt, "string");
    assert.ok(Array.isArray(summary.matches));
    assert.equal(summary.matches[0].domain, "billing");
    assert.ok(summary.matches[0].matchedKeywords.includes("refund"));
    assert.deepEqual(summary.matches[0].matchedGlobs, ["packages/billing/src/**"]);
    // Pointer, never payload (TCM-3).
    assert.equal(summary.matches[0].contextFile, ".devmate/contexts/billing.md");
    // Atomic write: no tmp file left behind.
    assert.ok(!existsSync(`${fx.contextPath}.tmp`), "tmp file must not remain");
    // The state file stays small (~2 KB budget for TOP_N=2).
    assert.ok(statSync(fx.contextPath).size < 2048, "state file must stay under 2 KB");
  } finally {
    fx.cleanup();
  }
});

test("domain-context › resolved domain ids are persisted to task.json as activeDomains", async () => {
  const fx = makeFixture({
    domains: DOMAINS_SECTION,
    state: makeState({ specFiles: ["packages/billing/src/checkout.ts"] }),
  });
  try {
    await runHook(fx.root, "fix the refund double-charge on invoices");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.deepEqual(state.activeDomains, ["billing"]);
  } finally {
    fx.cleanup();
  }
});

test("domain-context › unchanged resolution does not rewrite task.json", async () => {
  const fx = makeFixture({
    domains: DOMAINS_SECTION,
    state: makeState({ specFiles: ["packages/billing/src/checkout.ts"] }),
  });
  try {
    await runHook(fx.root, "fix the refund double-charge on invoices");
    const firstMtime = statSync(fx.statePath).mtimeMs;
    // Wait past the mtime resolution floor so a rewrite would be observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.equal(statSync(fx.statePath).mtimeMs, firstMtime);
  } finally {
    fx.cleanup();
  }
});

test("domain-context › no domains config: nothing written, stale file removed, output unchanged", async () => {
  const fx = makeFixture({});
  try {
    writeFileSync(
      fx.contextPath,
      JSON.stringify({ schemaVersion: 1, resolvedAt: "", matches: [] }),
      "utf8",
    );
    const result = await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.equal(result.action, "passthrough");
    assert.ok(!existsSync(fx.contextPath), "stale domain-context.json must be removed");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.activeDomains, undefined);
  } finally {
    fx.cleanup();
  }
});

test("domain-context › no domains config and no stale file: no write at all", async () => {
  const fx = makeFixture({});
  try {
    await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.ok(!existsSync(fx.contextPath));
  } finally {
    fx.cleanup();
  }
});

test("domain-context › empty domains array behaves like no domains", async () => {
  const fx = makeFixture({ domains: [] });
  try {
    writeFileSync(
      fx.contextPath,
      JSON.stringify({ schemaVersion: 1, resolvedAt: "", matches: [] }),
      "utf8",
    );
    await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.ok(!existsSync(fx.contextPath), "stale file must be removed");
  } finally {
    fx.cleanup();
  }
});

test("domain-context › malformed config never throws; state never outlives config", async () => {
  const fx = makeFixture({ rawConfig: "{ this is not json" });
  try {
    writeFileSync(
      fx.contextPath,
      JSON.stringify({ schemaVersion: 1, resolvedAt: "", matches: [] }),
      "utf8",
    );
    const result = await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.equal(result.action, "passthrough");
    assert.ok(!existsSync(fx.contextPath), "stale file must be removed on malformed config");
  } finally {
    fx.cleanup();
  }
});

test("domain-context › no task.json: matches still written, no crash, no state file invented", async () => {
  const fx = makeFixture({ domains: DOMAINS_SECTION, state: null });
  try {
    const result = await runHook(fx.root, "fix the refund double-charge on invoices");
    assert.equal(result.action, "passthrough");
    assert.ok(existsSync(fx.contextPath), "domain-context.json must be written");
    const summary = JSON.parse(readFileSync(fx.contextPath, "utf8"));
    assert.equal(summary.matches[0].domain, "billing");
    assert.ok(!existsSync(fx.statePath), "task.json must not be invented");
  } finally {
    fx.cleanup();
  }
});

test("domain-context › zero matches still writes an empty-matches file for consumers", async () => {
  const fx = makeFixture({ domains: DOMAINS_SECTION });
  try {
    await runHook(fx.root, "completely unrelated prose about weather");
    assert.ok(existsSync(fx.contextPath));
    const summary = JSON.parse(readFileSync(fx.contextPath, "utf8"));
    assert.deepEqual(summary.matches, []);
    // No matches and no prior activeDomains: task.json is left untouched.
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.activeDomains, undefined);
  } finally {
    fx.cleanup();
  }
});
