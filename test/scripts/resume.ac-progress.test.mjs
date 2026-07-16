// @ts-check
/**
 * AC-4 regression: the manual resume path (`scripts/resume.mjs`) must resolve
 * the persisted `acceptanceCriteria` and feed them to `buildResumePlan`, so a
 * task whose coarse trace steps are all complete but whose acceptance criteria
 * are NOT is never reported "nothing to resume".
 *
 * Before the fix, `resume.mjs` called `buildResumePlan` without
 * `acceptanceCriteria`; `implProgress.total` was 0, the
 * `already_complete -> proceed` correction never fired, and the task was
 * silently reported complete. These tests pin the corrected behavior and prove
 * the manual path is equivalent to the session-start path for identical state.
 *
 * All state lives under a fresh temp repo root; the resume CLI resolves both its
 * task state and its output relative to `process.cwd()`, so the resume cases
 * chdir into the temp root and restore afterwards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main as resumeMain } from "../../scripts/resume.mjs";
import { runWithIO } from "../../scripts/session-start.mjs";

/** @param {string} taskId @param {string} stepId @param {string} label */
const stepComplete = (taskId, stepId, label) => ({
  taskId,
  stepId,
  ts: "2026-06-24T10:00:00.000Z",
  schemaVersion: 1,
  type: "step_complete",
  label,
  artifactPaths: [],
});

/**
 * Build a devmate-ready temp repo root carrying a feature task's persisted
 * acceptance criteria and trace. The scaffolding (config, hooks, gate-guard)
 * is what `scripts/session-start.mjs` readiness checks require; the resume CLI
 * ignores it. Mirrors test/scripts/session-start.resume.test.mjs.
 * @param {{ taskId: string, acceptanceCriteria: string[], traceEvents: object[] }} opts
 * @returns {Promise<string>}
 */
async function makeRoot({ taskId, acceptanceCriteria, traceEvents }) {
  const root = await fsp.mkdtemp(join(tmpdir(), "resume-ac-"));
  await fsp.mkdir(join(root, ".git"), { recursive: true });
  await fsp.mkdir(join(root, ".devmate", "state", "trace"), { recursive: true });
  await fsp.writeFile(
    join(root, ".devmate", "devmate.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: "fullstack", editableGlobs: ["src/**"] }],
      verification: { unitTest: "node --test" },
    }),
    "utf8",
  );
  await fsp.mkdir(join(root, "hooks"), { recursive: true });
  await fsp.mkdir(join(root, "scripts"), { recursive: true });
  await fsp.writeFile(
    join(root, "hooks", "hooks.json"),
    JSON.stringify({
      schemaVersion: 1,
      hooks: {
        PreToolUse: [
          {
            type: "command",
            command: 'node "${PLUGIN_ROOT}/scripts/gate-guard.mjs"',
            timeout: 10,
          },
        ],
      },
    }),
    "utf8",
  );
  await fsp.writeFile(join(root, "scripts", "gate-guard.mjs"), "// gate-guard\n", "utf8");
  await fsp.writeFile(
    join(root, ".devmate", "state", "task.json"),
    JSON.stringify({
      taskId,
      lane: "feature",
      workflowGate: "impl-started",
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
      acceptanceCriteria,
    }),
    "utf8",
  );
  await fsp.writeFile(
    join(root, ".devmate", "state", "trace", `${taskId}.jsonl`),
    traceEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  return root;
}

/**
 * Run the manual resume CLI against a temp root, capturing stdout. The CLI is
 * cwd-relative, so we chdir in and restore on the way out.
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{ code: number, out: string }>}
 */
async function runResume(root, args) {
  const origCwd = process.cwd();
  const origWrite = process.stdout.write.bind(process.stdout);
  /** @type {string[]} */
  const out = [];
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string | Uint8Array} */ s) => {
      out.push(typeof s === "string" ? s : String(s));
      return true;
    }
  );
  try {
    process.chdir(root);
    const code = await resumeMain(args);
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
  }
}

/**
 * Drive scripts/session-start.mjs against a temp root (payload cwd == root).
 * @param {string} root
 * @returns {Promise<number>}
 */
async function runSessionStart(root) {
  const stdin = Readable.from([
    Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd: root }), "utf8"),
  ]);
  const sink = () =>
    /** @type {NodeJS.WritableStream} */ (
      /** @type {unknown} */ ({ write: () => true })
    );
  return runWithIO(stdin, sink(), sink());
}

/** @param {string} root @returns {Promise<any|null>} */
async function readPlan(root) {
  try {
    return JSON.parse(
      await fsp.readFile(join(root, ".devmate", "state", "resume-plan.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

test("AC-incomplete task: coarse steps done, only AC1 complete → surfaces remaining work", async () => {
  const taskId = "t-ac-incomplete";
  const root = await makeRoot({
    taskId,
    acceptanceCriteria: ["AC1: first", "AC2: second", "AC3: third"],
    traceEvents: [
      stepComplete(taskId, "s1", "setup"),
      stepComplete(taskId, "impl-AC1", "implement AC1"),
    ],
  });

  const { code, out } = await runResume(root, ["--task", taskId]);

  // proceed => exit 0, and the CLI must NOT claim the task is complete.
  assert.equal(code, 0);
  assert.match(out, /action: proceed/);
  assert.doesNotMatch(out, /already_complete/);
  assert.doesNotMatch(out, /Nothing to resume/i);
  assert.match(out, /nextStepId: impl-AC2/);

  const plan = await readPlan(root);
  assert.notEqual(plan, null, "resume-plan.json written");
  assert.equal(plan.action, "proceed");
  assert.equal(plan.nextStepId, "impl-AC2");
  assert.equal(plan.implProgress.total, 3);
  assert.equal(plan.implProgress.done, 1);
  assert.equal(plan.implProgress.nextId, 2);
});

test("genuinely complete task: all 3 ACs recorded → still reports complete (no false positive)", async () => {
  const taskId = "t-ac-complete";
  const root = await makeRoot({
    taskId,
    acceptanceCriteria: ["AC1: first", "AC2: second", "AC3: third"],
    traceEvents: [
      stepComplete(taskId, "s1", "setup"),
      stepComplete(taskId, "impl-AC1", "implement AC1"),
      stepComplete(taskId, "impl-AC2", "implement AC2"),
      stepComplete(taskId, "impl-AC3", "implement AC3"),
    ],
  });

  const { code, out } = await runResume(root, ["--task", taskId]);

  assert.equal(code, 0);
  assert.match(out, /action: already_complete/);

  const plan = await readPlan(root);
  assert.notEqual(plan, null);
  assert.equal(plan.action, "already_complete");
  assert.equal(plan.implProgress.total, 3);
  assert.equal(plan.implProgress.done, 3);
  assert.equal(plan.implProgress.nextId, null);
});

test("parity: session-start vs manual resume produce equivalent implProgress for identical state", async () => {
  const taskId = "t-parity";
  const acceptanceCriteria = ["AC1: first", "AC2: second", "AC3: third"];
  const traceEvents = [
    stepComplete(taskId, "s1", "setup"),
    stepComplete(taskId, "impl-AC1", "implement AC1"),
  ];

  const root = await makeRoot({ taskId, acceptanceCriteria, traceEvents });

  // session-start writes the plan first; capture it before resume overwrites.
  await runSessionStart(root);
  const sessionPlan = await readPlan(root);
  assert.notEqual(sessionPlan, null, "session-start wrote resume-plan.json");

  await runResume(root, ["--task", taskId]);
  const resumePlan = await readPlan(root);
  assert.notEqual(resumePlan, null, "resume wrote resume-plan.json");

  // The two writers must agree on the resume-driving decision for equal state.
  assert.deepEqual(resumePlan.implProgress, sessionPlan.implProgress);
  assert.equal(resumePlan.action, sessionPlan.action);
  assert.equal(resumePlan.nextStepId, sessionPlan.nextStepId);
  assert.equal(resumePlan.action, "proceed");
  assert.equal(resumePlan.nextStepId, "impl-AC2");
});
