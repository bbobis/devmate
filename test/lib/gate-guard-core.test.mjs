// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateGuard,
  extractApplyPatchPaths,
  filesOutsidePersonaScope,
  isSourceEditTool,
  matchGlob,
  ownsFile,
} from "../../lib/gate-guard-core.mjs";

/** @typedef {import('../../lib/types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../../lib/types.mjs').ConfigResult} ConfigResult */
/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

/** @type {DevmateConfig} */
const basicConfig = {
  schemaVersion: 1,
  personas: [
    { persona: "backend", editableGlobs: ["src/api/**", "lib/**"] },
    { persona: "frontend", editableGlobs: ["src/ui/**", "components/**"] },
  ],
};

/** @type {ConfigResult} */
const okConfig = { ok: true, config: basicConfig };

/** @type {ConfigResult} */
const failConfig = {
  ok: false,
  error: "Config file not found: .devmate/devmate.config.json",
};

/**
 * Build a minimal valid TaskState at the given gate.
 * @param {string} [gate]
 * @returns {TaskState}
 */
function makeState(gate) {
  return {
    taskId: "test-task",
    lane: /** @type {Lane} */ ("feature"),
    workflowGate: /** @type {WorkflowGate} */ (gate ?? "impl-started"),
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    tddGuard: {
      testFileWritten: true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    schemaVersion: 1,
  };
}

// ---- Rule 5 (persona scope) is GONE — the edit-time boundary is Rule 6 (#99) ----

test("evaluateGuard - takes no persona: an edit inside the task's scope is allowed whoever made it", () => {
  // The rule that used to sit here denied an edit whose path the *pinned persona*
  // did not own. It never ran (nothing pinned one), and it never could: a
  // PreToolUse payload carries no agent identity, so an edit cannot be attributed
  // to one of several concurrent workers. The signature no longer accepts a
  // persona, so there is no argument a caller could pass that revives it — and
  // none that could reach `ownsFile` as a non-persona string and deny every edit.
  const state = makeState("impl-started");
  const payload = { tool_name: "write_file", path: "src/ui/button.mjs" };
  const scope = /** @type {any} */ ({
    lane: "feature",
    allowedPaths: ["src/ui/button.mjs"],
    allowedGlobs: [],
  });
  const result = evaluateGuard(payload, state, okConfig, { scope });
  assert.equal(result.decision, "allow");
});

test("evaluateGuard - impl-started + scope.md present → Rule 6 governs (in-scope allow, out-of-scope deny)", () => {
  const scope = /** @type {any} */ ({ lane: "feature", allowedPaths: ["src/api/user.mjs"], allowedGlobs: [] });
  const state = makeState("impl-started");
  const inScope = evaluateGuard(
    { tool_name: "write_file", path: "src/api/user.mjs" },
    state,
    okConfig,
    { scope },
  );
  assert.equal(inScope.decision, "allow");
  const outScope = evaluateGuard(
    { tool_name: "write_file", path: "src/api/other.mjs" },
    state,
    okConfig,
    { scope },
  );
  assert.equal(outScope.decision, "deny");
  assert.ok(outScope.reason?.includes("scope.md"), `reason: ${outScope.reason}`);
});

// ---- isSourceEditTool ----

test("isSourceEditTool - str_replace_editor is source-edit tool", () => {
  assert.equal(isSourceEditTool("str_replace_editor", undefined), true);
});

test("isSourceEditTool - write_file is source-edit tool", () => {
  assert.equal(isSourceEditTool("write_file", undefined), true);
});

test("isSourceEditTool - insert_content_into_file is source-edit tool", () => {
  assert.equal(isSourceEditTool("insert_content_into_file", undefined), true);
});

test("isSourceEditTool - replace_in_file is source-edit tool", () => {
  assert.equal(isSourceEditTool("replace_in_file", undefined), true);
});

test("isSourceEditTool - read_file is NOT a source-edit tool", () => {
  assert.equal(isSourceEditTool("read_file", undefined), false);
});

test("isSourceEditTool - apply_patch (the persona edit tool) IS a source-edit tool", () => {
  assert.equal(isSourceEditTool("apply_patch", undefined), true);
});

test("isSourceEditTool - edit IS a source-edit tool", () => {
  assert.equal(isSourceEditTool("edit", undefined), true);
});

// ---- extractApplyPatchPaths ----

test("extractApplyPatchPaths - pulls Update/Add/Delete targets from a patch body", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/api/user.mjs",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/api/new.mjs",
    "*** Delete File: src/api/old.mjs",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(extractApplyPatchPaths(patch), [
    "src/api/user.mjs",
    "src/api/new.mjs",
    "src/api/old.mjs",
  ]);
});

test("extractApplyPatchPaths - non-patch / non-string input yields []", () => {
  assert.deepEqual(extractApplyPatchPaths("just some text"), []);
  assert.deepEqual(extractApplyPatchPaths(undefined), []);
  assert.deepEqual(extractApplyPatchPaths(null), []);
});

test("isSourceEditTool - shell with echo redirect to .mjs is source-edit tool", () => {
  assert.equal(isSourceEditTool("run_in_terminal", "echo foo > bar.mjs"), true);
});

test("isSourceEditTool - shell with ls is NOT a source-edit tool", () => {
  assert.equal(isSourceEditTool("run_in_terminal", "ls -la"), false);
});

test("isSourceEditTool - shell with cat redirect to .json is source-edit tool", () => {
  assert.equal(
    isSourceEditTool("run_in_terminal", "cat config.json > output.json"),
    true,
  );
});

test("isSourceEditTool - unknown tool name is NOT a source-edit tool", () => {
  assert.equal(isSourceEditTool("list_dir", undefined), false);
});

// ---- filesOutsidePersonaScope ----

/** @type {DevmateConfig} */
const scopeConfig = {
  schemaVersion: 1,
  personas: [
    { persona: "backend", editableGlobs: ["lib/**", "src/**"], offLimitsGlobs: ["src/ui/**"] },
    { persona: "frontend", editableGlobs: ["src/ui/**"] },
    { persona: "editor", editableGlobs: ["docs/**", "*.md"] },
  ],
};

test("filesOutsidePersonaScope - all owned → empty", () => {
  assert.deepEqual(filesOutsidePersonaScope("backend", ["lib/a.mjs", "src/b.mjs"], scopeConfig), []);
});

test("filesOutsidePersonaScope - off-limits file is a violation", () => {
  assert.deepEqual(filesOutsidePersonaScope("backend", ["src/ui/x.mjs"], scopeConfig), ["src/ui/x.mjs"]);
});

test("filesOutsidePersonaScope - file owned by another persona is a violation (partition breach)", () => {
  assert.deepEqual(filesOutsidePersonaScope("backend", ["docs/readme.md"], scopeConfig), ["docs/readme.md"]);
});

test("filesOutsidePersonaScope - file owned by NO persona is allowed (shared/config, not flagged)", () => {
  // package.json and infra/deploy.sh match no persona's editableGlobs → scope.md governs them, not this check.
  assert.deepEqual(filesOutsidePersonaScope("backend", ["package.json", "infra/deploy.sh"], scopeConfig), []);
});

test("filesOutsidePersonaScope - mixed: only the other-persona/off-limits files flagged", () => {
  const out = filesOutsidePersonaScope(
    "backend",
    ["lib/a.mjs", "src/ui/b.mjs", "package.json", "docs/x.md"],
    scopeConfig,
  );
  assert.deepEqual(out.sort(), ["docs/x.md", "src/ui/b.mjs"]);
});

test("filesOutsidePersonaScope - empty/null/non-string inputs → empty", () => {
  assert.deepEqual(filesOutsidePersonaScope("backend", [], scopeConfig), []);
  assert.deepEqual(filesOutsidePersonaScope("backend", /** @type {any} */ (null), scopeConfig), []);
  assert.deepEqual(
    filesOutsidePersonaScope("backend", /** @type {any} */ (["", 123, "lib/a.mjs"]), scopeConfig),
    [],
  );
});

test("filesOutsidePersonaScope - multi-root repo-prefixed paths resolve per persona", () => {
  /** @type {DevmateConfig} */
  const mr = {
    schemaVersion: 1,
    personas: [
      { persona: "backend", editableGlobs: ["src/**"], repo: "api" },
      { persona: "frontend", editableGlobs: ["src/**"], repo: "web" },
    ],
  };
  assert.deepEqual(filesOutsidePersonaScope("backend", ["api/src/x.ts"], mr), []);
  assert.deepEqual(filesOutsidePersonaScope("backend", ["web/src/y.ts"], mr), ["web/src/y.ts"]);
});

// ---- matchGlob ----

test("matchGlob - ** matches nested paths", () => {
  assert.equal(matchGlob("src/**/*.mjs", "src/api/user.mjs"), true);
});

test("matchGlob - * matches single segment", () => {
  assert.equal(matchGlob("src/*.mjs", "src/user.mjs"), true);
});

test("matchGlob - * does NOT match across directories", () => {
  assert.equal(matchGlob("src/*.mjs", "src/api/user.mjs"), false);
});

test("matchGlob - exact path match", () => {
  assert.equal(matchGlob("lib/types.mjs", "lib/types.mjs"), true);
});

test("matchGlob - no match on different extension", () => {
  assert.equal(matchGlob("src/**/*.mjs", "src/api/user.ts"), false);
});

// ---- ownsFile ----

test("ownsFile - backend owns src/api/user.mjs", () => {
  assert.equal(ownsFile("backend", "src/api/user.mjs", basicConfig), true);
});

test("ownsFile - frontend does NOT own src/api/user.mjs (backend scope)", () => {
  assert.equal(ownsFile("frontend", "src/api/user.mjs", basicConfig), false);
});

test("ownsFile - frontend owns src/ui/button.mjs", () => {
  assert.equal(ownsFile("frontend", "src/ui/button.mjs", basicConfig), true);
});

test("ownsFile - unknown persona does not own any path", () => {
  assert.equal(ownsFile("devops", "src/api/user.mjs", basicConfig), false);
});

test("ownsFile - offLimitsGlobs blocks ownership even when editableGlob matches", () => {
  /** @type {DevmateConfig} */
  const cfg = {
    schemaVersion: 1,
    personas: [
      {
        persona: "backend",
        editableGlobs: ["src/**"],
        offLimitsGlobs: ["src/ui/**"],
      },
    ],
  };
  assert.equal(ownsFile("backend", "src/ui/button.mjs", cfg), false);
  assert.equal(ownsFile("backend", "src/api/user.mjs", cfg), true);
});

// ---- evaluateGuard ----

test("evaluateGuard - null state + source-edit tool = deny mentioning unreadable", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "write_file", path: "src/api/user.mjs" };
  const result = evaluateGuard(payload, null, okConfig);
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("unreadable"));
});

test("evaluateGuard - null state + non-edit tool = allow", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "read_file" };
  const result = evaluateGuard(payload, null, okConfig);
  assert.equal(result.decision, "allow");
});

test("evaluateGuard - null state + apply_patch source edit = deny (closes the persona bypass)", () => {
  // apply_patch is the tool a persona uses to edit directly; the hook attributes
  // its target path from the patch body. With no active task, the edit is
  // ungated and must be denied, steering the user through the orchestrator.
  /** @type {HookPayload} */
  const payload = { tool_name: "apply_patch", path: "src/api/user.mjs" };
  const result = evaluateGuard(payload, null, okConfig);
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("orchestrator"));
});

test("evaluateGuard - valid state at plan-approved + source-edit = deny mentioning plan-approved", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "str_replace_editor", path: "src/api/user.mjs" };
  const result = evaluateGuard(
    payload,
    makeState("plan-approved"),
    okConfig,
  );
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("plan-approved"));
});

test("evaluateGuard - valid state at impl-started + source-edit in owned path = allow", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "write_file", path: "src/api/user.mjs" };
  // #92: the lane's edit boundary is now required at every gate where editing is
  // permitted — without a scope contract Rule 6 denies before persona ownership
  // is ever consulted, which is not what this test is about.
  const scope = /** @type {any} */ ({
    lane: "feature",
    allowedPaths: ["src/api/user.mjs"],
    allowedGlobs: [],
  });
  const result = evaluateGuard(
    payload,
    makeState("impl-started"),
    okConfig,
    { scope },
  );
  assert.equal(result.decision, "allow");
});

test("evaluateGuard - valid state at impl-started + source-edit with no scope contract = deny (Rule 6, not the persona)", () => {
  // Asserted a persona deny until #99 — a rule that could not fire in production
  // (nothing pinned `activePersona`), reached here only because the test passed
  // one in by hand. What actually bounds this edit is the task's scope contract,
  // and its absence denies.
  /** @type {HookPayload} */
  const payload = { tool_name: "write_file", path: "src/ui/button.mjs" };
  const result = evaluateGuard(
    payload,
    makeState("impl-started"),
    okConfig,
  );
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("scope contract"), `reason: ${result.reason}`);
  assert.ok(!result.reason?.includes("editableGlobs"), 'no persona verdict may appear here');
});

// #77: the agent identity is an OPTS input, and the tool name is one VS Code
// actually sends. Both used to be fictions: `agentId` on the payload (no host
// sends it) and `write_file` (no host sends that either), so these two tests
// passed while the production rule they describe could not fire at all.
//
// #93: the rule is no longer identity-GATED, it is identity-EXCEPTED. The
// protected paths deny by default (no identity needed, which is why it can
// finally enforce at an event that carries none), and a declared writer is the
// only way through.
test("evaluateGuard - declared writer may write its artifact even when state is null", () => {
  /** @type {HookPayload} */
  const payload = {
    tool_name: "create_file",
    path: ".devmate/session/spec.md",
  };
  const result = evaluateGuard(payload, null, okConfig, {
    activeAgent: "spec-writer",
  });
  assert.equal(result.decision, "allow");
});

test("evaluateGuard - session artifact write by a non-writer agent = deny", () => {
  /** @type {HookPayload} */
  const payload = {
    tool_name: "create_file",
    path: ".devmate/state/task.json",
  };
  const result = evaluateGuard(
    payload,
    makeState("impl-started"),
    okConfig,
    { activeAgent: "fullstack" },
  );
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("session artifact"));
  assert.ok(result.reason?.includes("fullstack"));
});

// ---- Config missing/invalid (E10 fail-safe) ----

test("evaluateGuard - config missing + source-edit = deny with devmate init hint", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "write_file", path: "src/api/user.mjs" };
  const result = evaluateGuard(
    payload,
    makeState("impl-started"),
    failConfig,
  );
  assert.equal(result.decision, "deny");
  assert.ok(result.reason?.includes("devmate init"));
});

test("evaluateGuard - config missing + non-edit tool = allow", () => {
  /** @type {HookPayload} */
  const payload = { tool_name: "read_file" };
  const result = evaluateGuard(
    payload,
    makeState("impl-started"),
    failConfig,
  );
  assert.equal(result.decision, "allow");
});
