// @ts-check
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  handoffTaskDir,
  writeHandoff,
} from "../../../lib/handoff/write-handoff.mjs";

/** @returns {Promise<string>} a fresh tmp handoff dir */
async function makeHandoffDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "devmate-handoff-"));
}

/** @returns {import('../../../lib/types.mjs').HandoffInput} */
function makeInput(over = {}) {
  return {
    taskId: "feat-1",
    purpose: "Ship the trace subsystem.",
    currentState: "in_progress",
    decisions: ["Use stepId identity"],
    openQuestions: ["Where to store handoff?"],
    evidencePointers: [],
    suggestedNextSkill: null,
    blockers: [],
    ...over,
  };
}

test("writes both handoff.json and handoff.md for a valid input", async () => {
  const handoffDir = await makeHandoffDir();
  const { jsonPath, mdPath } = await writeHandoff(makeInput(), { handoffDir });
  const json = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
  assert.equal(json.taskId, "feat-1");
  assert.equal(json.schemaVersion, 1);
  assert.ok(typeof json.ts === "string" && json.ts.length > 0);
  const md = await fsp.readFile(mdPath, "utf8");
  assert.match(md, /# Handoff: feat-1/);
  assert.match(md, /## Purpose/);
});

test("halted task: two blockers → blockers length 2 and md has Blockers section", async () => {
  const handoffDir = await makeHandoffDir();
  const { jsonPath, mdPath } = await writeHandoff(
    makeInput({ currentState: "halted", blockers: ["b1", "b2"] }),
    { handoffDir },
  );
  const json = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
  assert.equal(json.blockers.length, 2);
  const md = await fsp.readFile(mdPath, "utf8");
  assert.match(md, /## Blockers/);
  assert.match(md, /- b1/);
});

test("file evidence pointer → md uses backtick span, not inline content", async () => {
  const handoffDir = await makeHandoffDir();
  const { mdPath } = await writeHandoff(
    makeInput({
      evidencePointers: [
        {
          kind: "file",
          path_or_url: "lib/trace/append.mjs",
          line_range: "10-20",
          why_relevant: "append logic",
          confidence: "high",
        },
      ],
    }),
    { handoffDir },
  );
  const md = await fsp.readFile(mdPath, "utf8");
  assert.match(md, /`lib\/trace\/append\.mjs`/);
  assert.match(md, /lines 10-20/);
});

test("url evidence pointer → md renders as a markdown link", async () => {
  const handoffDir = await makeHandoffDir();
  const { mdPath } = await writeHandoff(
    makeInput({
      evidencePointers: [
        {
          kind: "url",
          path_or_url: "https://code.visualstudio.com/docs",
          why_relevant: "official docs",
          confidence: "medium",
        },
      ],
    }),
    { handoffDir },
  );
  const md = await fsp.readFile(mdPath, "utf8");
  assert.match(
    md,
    /\[https:\/\/code\.visualstudio\.com\/docs\]\(https:\/\/code\.visualstudio\.com\/docs\)/,
  );
});

test("compacted state → suggestedNextSkill present in JSON (may be null)", async () => {
  const handoffDir = await makeHandoffDir();
  const { jsonPath } = await writeHandoff(
    makeInput({ currentState: "compacted", suggestedNextSkill: null }),
    { handoffDir },
  );
  const json = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
  assert.ok("suggestedNextSkill" in json);
  assert.equal(json.suggestedNextSkill, null);
});

test("invalid input (bad currentState) → throws", async () => {
  const handoffDir = await makeHandoffDir();
  await assert.rejects(
    () => writeHandoff(makeInput({ currentState: "bogus" }), { handoffDir }),
    /currentState/,
  );
});

test("writes under .devmate/state/handoff/<taskId>/", async () => {
  const handoffDir = await makeHandoffDir();
  await writeHandoff(makeInput(), { handoffDir });
  await fsp.access(
    path.join(handoffTaskDir("feat-1", handoffDir), "handoff.json"),
  );
});
