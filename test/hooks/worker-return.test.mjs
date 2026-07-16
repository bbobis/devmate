// @ts-check
/**
 * Worker-return persistence, driven by the CAPTURED runSubagent payload.
 *
 * The payload is ground truth (test/fixtures/hook-payloads/captured/
 * posttooluse.run-subagent.json): `tool_response` is a plain STRING holding the
 * agent's final text — prose, then an embedded JSON contract. Every hand-authored
 * test before this one assumed a structured object, which is precisely why the
 * code that did `JSON.parse(tool_response)` shipped green while returning null on
 * every real dispatch.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { extractAgentResult } from "../../lib/hooks/agent-result.mjs";
import { extractChangedFilesFromToolResponse } from "../../hooks/post-tool-use.mjs";
import {
  persistWorkerReturn,
  workerReturnFilename,
  WORKER_RETURNS_DIR,
} from "../../lib/workflow/persist-worker-return.mjs";

const FIXTURE = resolve(
  import.meta.dirname ?? ".",
  "..",
  "fixtures",
  "hook-payloads",
  "captured",
  "posttooluse.run-subagent.json",
);

/** @returns {{ root: string, cleanup: () => void }} */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "worker-return-"));
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("extractAgentResult — reads the contract out of a real (prose + JSON) response", () => {
  const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const extracted = extractAgentResult(payload.tool_response);

  // The whole defect in one assertion: a bare JSON.parse of this string throws.
  assert.throws(() => JSON.parse(payload.tool_response));

  assert.equal(extracted.empty, false);
  assert.equal(extracted.agentName, "router");
  assert.equal(extracted.result?.lane, "feature");
  assert.equal(extracted.result?.budgetClass, "standard");
});

test("extractAgentResult — an empty response is reported as empty, not as a shape error", () => {
  // This is "Agent completed with no output". It must be distinguishable, because
  // it is the case the orchestrator silently routed around by doing the work
  // itself.
  assert.deepEqual(extractAgentResult(""), { agentName: null, result: null, empty: true });
  assert.deepEqual(extractAgentResult(null), { agentName: null, result: null, empty: true });
});

test("extractAgentResult — prose with no contract is a shape error, not emptiness", () => {
  const extracted = extractAgentResult("I looked around but did not produce JSON.");
  assert.equal(extracted.empty, false);
  assert.equal(extracted.result, null);
});

test("extractChangedFilesFromToolResponse — works on the real prose+JSON shape", () => {
  // Previously JSON.parse'd the whole string, so this returned null for every
  // real @fullstack dispatch and the persona-scope tripwire never fired.
  const contract = JSON.stringify({
    agentName: 'fullstack',
    status: 'ok',
    payload: { changedFiles: ['lib/a.mjs', 'test/a.test.mjs'] },
  });
  const response = `Done — implemented the change and ran the tests.\n\n${contract}`;
  assert.deepEqual(extractChangedFilesFromToolResponse(response), [
    "lib/a.mjs",
    "test/a.test.mjs",
  ]);
});

test("workerReturnFilename — keyed by dispatch, so a parallel wave does not overwrite itself", () => {
  // The orchestrator dispatches @discovery K times in ONE wave. Keying the file
  // by agent name alone would leave a single survivor and make a fan-out look
  // like it mostly vanished.
  const a = workerReturnFilename("discovery", "toolu_aaa__vscode-1");
  const b = workerReturnFilename("discovery", "toolu_bbb__vscode-2");
  assert.notEqual(a, b);
  assert.match(a, /^discovery\./);
});

test("persistWorkerReturn — writes the artifact the dispatch protocol depends on", async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const extracted = extractAgentResult(payload.tool_response);

    const path = await persistWorkerReturn(root, {
      agentName: /** @type {string} */ (extracted.agentName),
      toolUseId: payload.tool_use_id,
      result: /** @type {Record<string, unknown>} */ (extracted.result),
    });

    // orch-assert-dispatch --file <path> and merge-discovery both depend on a
    // file existing here. Until now, nothing could create one.
    const files = readdirSync(join(root, WORKER_RETURNS_DIR));
    assert.equal(files.length, 1);

    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.agentName, "router");
    assert.equal(written.lane, "feature");
  } finally {
    cleanup();
  }
});
