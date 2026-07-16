// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serializeWorkerReturn,
  validateWorkerReturn,
  WorkerContractError,
  WorkerReturnBuilder,
} from "../../../lib/context/worker-contract.mjs";

/**
 * A valid evidence pointer.
 * @returns {import('../../../lib/types.mjs').EvidencePointer}
 */
function ptr() {
  return {
    path: "lib/x.mjs",
    lineRange: [1, 5],
    reason: "relevant",
    confidence: 0.8,
    freshness: "2026-06-24T00:00:00Z",
    kind: "file",
  };
}

/**
 * A valid WorkerReturn, with optional overrides.
 * @param {Partial<import('../../../lib/types.mjs').WorkerReturn>} [over]
 * @returns {import('../../../lib/types.mjs').WorkerReturn}
 */
function validReturn(over = {}) {
  return {
    workerId: "w-1",
    finding: "Found the bug in the parser.",
    sourcePointer: ptr(),
    confidence: 0.9,
    artifactWritten: null,
    nextRecommendedStep: "Apply the fix to the tokenizer.",
    tokenNotes: "Loaded 2 slices, ~800 tokens",
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: "2026-06-24T00:00:00Z",
    ...over,
  };
}

test("validateWorkerReturn / valid full object → ok: true", () => {
  const r = validateWorkerReturn(validReturn());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateWorkerReturn / rawTranscriptPath set when debugMode=false → error", () => {
  const r = validateWorkerReturn(
    validReturn({ debugMode: false, rawTranscriptPath: "/tmp/log.txt" }),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.includes("rawTranscriptPath must be null when debugMode=false"),
  );
});

test("validateWorkerReturn / finding > 500 chars → error", () => {
  const r = validateWorkerReturn(validReturn({ finding: "x".repeat(501) }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /finding exceeds 500/.test(e)));
});

test("validateWorkerReturn / nextRecommendedStep > 200 chars → error", () => {
  const r = validateWorkerReturn(
    validReturn({ nextRecommendedStep: "y".repeat(201) }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /nextRecommendedStep exceeds 200/.test(e)));
});

test("validateWorkerReturn / confidence = 1.5 → error", () => {
  const r = validateWorkerReturn(validReturn({ confidence: 1.5 }));
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /confidence must be a number in \[0.0, 1.0\]/.test(e)),
  );
});

test("validateWorkerReturn / sourcePointer missing path → error", () => {
  const bad = validReturn();
  // @ts-expect-error intentionally remove path
  delete bad.sourcePointer.path;
  const r = validateWorkerReturn(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /sourcePointer.path/.test(e)));
});

test("validateWorkerReturn / collects all errors (no short-circuit)", () => {
  const r = validateWorkerReturn({
    workerId: "",
    finding: "z".repeat(600),
    sourcePointer: { path: "", reason: "", confidence: 5, freshness: "" },
    confidence: -1,
    artifactWritten: 42,
    nextRecommendedStep: "q".repeat(300),
    tokenNotes: "",
    debugMode: false,
    rawTranscriptPath: "/x",
    returnedAt: "",
  });
  assert.equal(r.ok, false);
  // Many distinct violations should be present at once.
  assert.ok(
    r.errors.length >= 8,
    `expected many errors, got ${r.errors.length}: ${r.errors.join(" | ")}`,
  );
});

test("WorkerReturnBuilder / setDebugMode(false, path) forces null rawTranscriptPath", () => {
  const b = new WorkerReturnBuilder("w-2").setDebugMode(false, "/some/path");
  assert.equal(b.debugMode, false);
  assert.equal(b.rawTranscriptPath, null);
});

test("WorkerReturnBuilder / build() throws WorkerContractError on validation failure", () => {
  const b = new WorkerReturnBuilder("w-3"); // missing required fields
  assert.throws(
    () => b.build(),
    (err) => {
      assert.ok(err instanceof WorkerContractError);
      assert.ok(
        Array.isArray(/** @type {WorkerContractError} */ (err).violations),
      );
      assert.ok(/** @type {WorkerContractError} */ (err).violations.length > 0);
      return true;
    },
  );
});

test("WorkerReturnBuilder / build() succeeds on valid configuration", () => {
  const ret = new WorkerReturnBuilder("w-4")
    .setFinding("Did the thing.")
    .setSourcePointer(ptr())
    .setConfidence(0.7)
    .setArtifactWritten(".devmate/state/out.json")
    .setNextStep("Verify the output.")
    .setTokenNotes("~300 tokens")
    .build();
  assert.equal(ret.workerId, "w-4");
  assert.equal(ret.artifactWritten, ".devmate/state/out.json");
  assert.equal(ret.debugMode, false);
  assert.equal(ret.rawTranscriptPath, null);
});

test("WorkerReturnBuilder / setConfidence rejects out-of-range value", () => {
  assert.throws(
    () => new WorkerReturnBuilder("w-5").setConfidence(2),
    TypeError,
  );
});

test("serializeWorkerReturn / produces compact JSON", () => {
  const s = serializeWorkerReturn(validReturn());
  assert.ok(!s.includes("\n"));
  assert.ok(!/: /.test(s.replace(/"[^"]*"/g, ""))); // no pretty-print spacing outside string values
  assert.deepEqual(JSON.parse(s).workerId, "w-1");
});

test("debugMode=true allows a rawTranscriptPath", () => {
  const r = validateWorkerReturn(
    validReturn({ debugMode: true, rawTranscriptPath: "/tmp/raw.log" }),
  );
  assert.equal(r.ok, true);
});
