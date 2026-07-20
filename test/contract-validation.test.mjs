// @ts-check
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  validateCritiqueResult,
  validateDiagnosisResult,
  validateGrillResult,
  validateWorkerReturn,
} from '../lib/workflow/contracts.mjs';
import { assertDiagnosisResult } from '../lib/workflow/bug-handoff.mjs';
import { runWithIO } from '../hooks/contract-validator.mjs';

import { markSessionForFile } from '../lib/test-utils/hook-session.mjs';

// Enforcement is session-scoped (lib/hooks/session-marker.mjs): these tests
// exercise handlers inside an ACTIVE devmate session, so mark one for the
// whole file and stamp its id into each payload.
const TEST_SESSION_ID = markSessionForFile('devmate-test-contract-validation');

/** @returns {import('../lib/types.mjs').WorkerReturn} */
function makeWorkerReturn() {
  return {
    workerId: 'w-1',
    finding: 'ok',
    sourcePointer: {
      kind: 'file',
      path: 'lib/workflow/contracts.mjs',
      lineRange: null,
      reason: 'unit fixture',
      confidence: 0.9,
      freshness: 'fresh',
    },
    confidence: 0.9,
    artifactWritten: null,
    nextRecommendedStep: 'continue',
    tokenNotes: '100 tokens',
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: new Date().toISOString(),
  };
}

/** @returns {import('../lib/types.mjs').DiagnosisResult} */
function makeDiagnosis() {
  return {
    bugScope: 'backend',
    suspectedLayer: 'service',
    reproCommand: 'npm test',
    fixerRecommendation: 'add guard',
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/app.mjs'],
    allowedGlobs: [],
    taskId: 'task-1',
    schemaVersion: 1,
  };
}

/** @returns {import('../lib/types.mjs').GrillResult} */
function makeGrill() {
  return {
    taskId: 'task-1',
    mode: 'grill',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    assumptions: ['a'],
    missingRequirements: ['b'],
    edgeCases: ['c'],
    cornerCases: ['d'],
    securityRisks: ['e'],
    uxRisks: ['f'],
    blockingQuestions: ['g'],
    recommendedDecisions: ['h'],
    unverifiedItems: [],
    risks: ['e', 'f'],
    revisionsRequested: 0,
  };
}

/** @returns {import('../lib/types.mjs').CritiqueResult} */
function makeCritique() {
  return {
    taskId: 'task-1',
    mode: 'critique',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    missingAcceptanceCriteria: ['a'],
    missingTests: ['b'],
    riskySequencing: ['c'],
    unlistedFiles: ['d'],
    backwardsCompatRisks: ['e'],
    rollbackRisk: 'medium',
    verdict: 'APPROVE_PLAN',
    revisionsRequested: 0,
  };
}

/**
 * @param {string} text
 * @returns {NodeJS.ReadableStream}
 */
function stringReadable(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

/**
 * @returns {{ stream: NodeJS.WritableStream, get: () => string }}
 */
function captureWritable() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      cb();
    },
  });
  return { stream, get: () => chunks.join('') };
}

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeWorkspace() {
  const scratchBase = path.join(process.cwd(), '.tmp-test');
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'devmate-contracts-'));
  mkdirSync(path.join(root, '.devmate/state/worker-returns'), { recursive: true });
  // E9-18 read-before-assert: cited pointers must resolve inside the
  // workspace, so seed the file the fixtures point at.
  mkdirSync(path.join(root, 'lib/workflow'), { recursive: true });
  writeFileSync(path.join(root, 'lib/workflow/contracts.mjs'), '// fixture\n', 'utf8');
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('validateWorkerReturn smoke and rejection cases', () => {
  const good = validateWorkerReturn(makeWorkerReturn());
  assert.equal(good.ok, true);

  const missingWorker = makeWorkerReturn();
  // @ts-expect-error test fixture mutation
  delete missingWorker.workerId;
  assert.equal(validateWorkerReturn(missingWorker).ok, false);

  const missingSource = makeWorkerReturn();
  // @ts-expect-error test fixture mutation
  delete missingSource.sourcePointer;
  assert.equal(validateWorkerReturn(missingSource).ok, false);

  const badConfidence = makeWorkerReturn();
  badConfidence.confidence = 2;
  assert.equal(validateWorkerReturn(badConfidence).ok, false);

  const badTranscript = makeWorkerReturn();
  badTranscript.rawTranscriptPath = 'tmp/raw.txt';
  assert.equal(validateWorkerReturn(badTranscript).ok, false);
});

test('validateDiagnosisResult rejects malformed and accepts valid', () => {
  assert.equal(validateDiagnosisResult(null).ok, false);
  assert.equal(validateDiagnosisResult('x').ok, false);

  const d = makeDiagnosis();
  // @ts-expect-error test fixture mutation
  delete d.bugScope;
  assert.equal(validateDiagnosisResult(d).ok, false);

  const wrongVersion = makeDiagnosis();
  wrongVersion.schemaVersion = 2;
  assert.equal(validateDiagnosisResult(wrongVersion).ok, false);

  assert.equal(validateDiagnosisResult(makeDiagnosis()).ok, true);
});

test('validateGrillResult rejects malformed and accepts valid', () => {
  assert.equal(validateGrillResult(null).ok, false);
  assert.equal(validateGrillResult('x').ok, false);

  const g = makeGrill();
  // @ts-expect-error test fixture mutation
  delete g.assumptions;
  assert.equal(validateGrillResult(g).ok, false);

  const nonArray = makeGrill();
  // @ts-expect-error intentional bad type
  nonArray.edgeCases = 'x';
  assert.equal(validateGrillResult(nonArray).ok, false);

  const wrongMode = makeGrill();
  // @ts-expect-error intentional bad type
  wrongMode.mode = 'critique';
  assert.equal(validateGrillResult(wrongMode).ok, false);

  const wrongVersion = makeGrill();
  wrongVersion.schemaVersion = 2;
  assert.equal(validateGrillResult(wrongVersion).ok, false);

  assert.equal(validateGrillResult(makeGrill()).ok, true);
});

test('validateCritiqueResult rejects malformed and accepts valid', () => {
  assert.equal(validateCritiqueResult(null).ok, false);
  assert.equal(validateCritiqueResult('x').ok, false);

  const c = makeCritique();
  // @ts-expect-error test fixture mutation
  delete c.missingTests;
  assert.equal(validateCritiqueResult(c).ok, false);

  const nonArray = makeCritique();
  // @ts-expect-error intentional bad type
  nonArray.unlistedFiles = 'x';
  assert.equal(validateCritiqueResult(nonArray).ok, false);

  const wrongMode = makeCritique();
  // @ts-expect-error intentional bad type
  wrongMode.mode = 'grill';
  assert.equal(validateCritiqueResult(wrongMode).ok, false);

  const wrongVersion = makeCritique();
  wrongVersion.schemaVersion = 3;
  assert.equal(validateCritiqueResult(wrongVersion).ok, false);

  assert.equal(validateCritiqueResult(makeCritique()).ok, true);
});

test('all validators are non-throwing and return { ok, errors } shape', () => {
  assert.doesNotThrow(() => validateWorkerReturn({}));
  assert.doesNotThrow(() => validateDiagnosisResult({}));
  assert.doesNotThrow(() => validateGrillResult({}));
  assert.doesNotThrow(() => validateCritiqueResult({}));

  for (const out of [
    validateWorkerReturn({}),
    validateDiagnosisResult({}),
    validateGrillResult({}),
    validateCritiqueResult({}),
  ]) {
    assert.equal(typeof out.ok, 'boolean');
    assert.ok(Array.isArray(out.errors));
  }
});

test('bug-handoff assertDiagnosisResult still throws for invalid input', () => {
  assert.throws(() => assertDiagnosisResult({}), TypeError);
});

test('contract-validator rejects malformed worker-return artifact', async () => {
  const ws = makeWorkspace();
  try {
    const artifact = path.join(ws.root, '.devmate/state/worker-returns/a.json');
    writeFileSync(
      artifact,
      JSON.stringify({ ...makeWorkerReturn(), confidence: 99 }),
      'utf8',
    );

    const stdout = captureWritable();
    const stderr = captureWritable();
    const payload = {
      session_id: TEST_SESSION_ID,
      cwd: ws.root,
      tool_input: { filePath: artifact },
    };

    const code = await runWithIO(
      stringReadable(JSON.stringify(payload)),
      stdout.stream,
      stderr.stream,
    );

    assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
    assert.match(stderr.get(), /WorkerReturn/);
    assert.match(stderr.get(), /confidence/);
  } finally {
    ws.cleanup();
  }
});

test('contract-validator rejects malformed diagnosis and appends contract_violation trace', async () => {
  const ws = makeWorkspace();
  try {
    const artifact = path.join(ws.root, '.devmate/state/diagnosis.json');
    writeFileSync(
      artifact,
      JSON.stringify({ ...makeDiagnosis(), schemaVersion: 2 }),
      'utf8',
    );

    const stderr = captureWritable();
    const payload = {
      session_id: TEST_SESSION_ID,
      cwd: ws.root,
      tool_input: { filePath: artifact },
    };
    const code = await runWithIO(
      stringReadable(JSON.stringify(payload)),
      captureWritable().stream,
      stderr.stream,
    );

    assert.equal(code, 2); // #77: exit 2 is the only non-zero code VS Code treats as blocking
    const tracePath = path.join(ws.root, '.devmate/state/trace/task-1.jsonl');
    assert.equal(existsSync(tracePath), true);
    const lines = readFileSync(tracePath, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    assert.equal(event.type, 'contract_violation');
    assert.equal(event.contract, 'DiagnosisResult');
  } finally {
    ws.cleanup();
  }
});

test('contract-validator no-ops for unrouted path', async () => {
  const ws = makeWorkspace();
  try {
    const payload = {
      session_id: TEST_SESSION_ID,
      cwd: ws.root,
      tool_input: { filePath: path.join(ws.root, 'notes.txt') },
    };
    const code = await runWithIO(
      stringReadable(JSON.stringify(payload)),
      captureWritable().stream,
      captureWritable().stream,
    );

    assert.equal(code, 0);
    const traceDir = path.join(ws.root, '.devmate/state/trace');
    assert.equal(existsSync(traceDir), false);
  } finally {
    ws.cleanup();
  }
});

test('contract-validator allows valid routed artifacts', async () => {
  const ws = makeWorkspace();
  try {
    /** @type {Array<[string, unknown]>} */
    const files = [
      ['.devmate/state/worker-returns/ok.json', makeWorkerReturn()],
      ['.devmate/state/diagnosis.json', makeDiagnosis()],
      ['.devmate/state/grill-result.json', makeGrill()],
      ['.devmate/state/critique-result.json', makeCritique()],
    ];

    // @bounded-alloc — writes the handful of fixture files declared by this test case.
    for (const [rel, body] of files) {
      const abs = path.join(ws.root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, JSON.stringify(body), 'utf8');

      const code = await runWithIO(
        stringReadable(JSON.stringify({ cwd: ws.root, tool_input: { filePath: abs } })),
        captureWritable().stream,
        captureWritable().stream,
      );
      assert.equal(code, 0, `expected pass for ${rel}`);
    }

    const traceDir = path.join(ws.root, '.devmate/state/trace');
    assert.equal(existsSync(traceDir), false);
  } finally {
    ws.cleanup();
  }
});
