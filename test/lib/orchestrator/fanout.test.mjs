// @ts-check
/**
 * E8-1: tests for the orchestrator-workers fanout module.
 * Telemetry is redirected to a temp ledger so the repo file is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fanout } from '../../../lib/orchestrator/fanout.mjs';

/** @typedef {import('../../../lib/types.mjs').WorkerReturn} WorkerReturn */

/** @returns {Promise<string>} a unique temp telemetry ledger path. */
async function tempLedger() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'fanout-'));
  return join(dir, 'workers.jsonl');
}

/**
 * Build a valid WorkerReturn fixture.
 * @param {string} id
 * @param {Partial<WorkerReturn>} [over]
 * @returns {WorkerReturn}
 */
function makeReturn(id, over = {}) {
  /** @type {WorkerReturn} */
  const base = {
    workerId: id,
    finding: `finding from ${id}`,
    sourcePointer: {
      path: 'README.md',
      lineRange: null,
      reason: 'relevant',
      confidence: 0.9,
      freshness: '2026-06-24T00:00:00.000Z',
      kind: 'file',
    },
    confidence: 0.8,
    artifactWritten: null,
    nextRecommendedStep: 'Continue.',
    tokenNotes: '~200 tokens',
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: '2026-06-24T00:00:01.000Z',
  };
  return { ...base, ...over };
}

test('fanout › resolves when budgetClass is standard and strict is not set', async () => {
  const telemetryPath = await tempLedger();
  const res = await fanout(
    [() => Promise.resolve(makeReturn('a'))],
    { budgetClass: 'standard', telemetryPath }
  );
  assert.equal(res.results.length, 1);
  assert.equal(res.violations.length, 0);
});

test('fanout strict › rejects when budgetClass is standard and strict is true', async () => {
  await assert.rejects(
    () => fanout([() => Promise.resolve(makeReturn('a'))], { budgetClass: 'standard', strict: true }),
    /fanout strict mode requires large budget/
  );
});

test('fanout strict › rejects when budgetClass is tiny and strict is true', async () => {
  await assert.rejects(
    () => fanout([() => Promise.resolve(makeReturn('a'))], { budgetClass: 'tiny', strict: true }),
    /fanout strict mode requires large budget/
  );
});

test('fanout › runs all workers in parallel for large budget', async () => {
  const telemetryPath = await tempLedger();
  const workers = [
    () => Promise.resolve(makeReturn('a')),
    () => Promise.resolve(makeReturn('b')),
    () => Promise.resolve(makeReturn('c')),
  ];
  const res = await fanout(workers, { budgetClass: 'large', telemetryPath });
  assert.equal(res.results.length, 3);
  assert.equal(res.violations.length, 0);
  assert.equal(res.telemetry.length, 3);
  assert.deepEqual(res.results.map((r) => r.workerId).sort(), ['a', 'b', 'c']);
});

test('fanout › timeout fires and worker collected as violation', async () => {
  const telemetryPath = await tempLedger();
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(makeReturn('slow')), 1000));
  const fast = () => Promise.resolve(makeReturn('fast'));
  const res = await fanout([slow, fast], { budgetClass: 'large', timeoutMs: 20, telemetryPath });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, 'fast');
  assert.equal(res.violations.length, 1);
});

test('fanout › contract violation collected without throw', async () => {
  const telemetryPath = await tempLedger();
  // confidence out of range → invalid WorkerReturn.
  const bad = () => Promise.resolve(makeReturn('bad', { confidence: 5 }));
  const good = () => Promise.resolve(makeReturn('good'));
  const res = await fanout([bad, good], { budgetClass: 'large', telemetryPath });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, 'good');
  assert.deepEqual(res.violations, ['bad']);
});

test('fanout › dryRun returns summary, workers not called', async () => {
  let called = 0;
  const workers = [
    () => { called++; return Promise.resolve(makeReturn('a')); },
    () => { called++; return Promise.resolve(makeReturn('b')); },
  ];
  const res = await fanout(workers, { budgetClass: 'large', dryRun: true });
  assert.equal(called, 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.planned, 2);
  assert.equal(res.results.length, 0);
});

test('fanout strict › resolves when budgetClass is large and strict is true', async () => {
  const telemetryPath = await tempLedger();
  const res = await fanout(
    [() => Promise.resolve(makeReturn('a'))],
    { budgetClass: 'large', strict: true, telemetryPath }
  );
  assert.equal(res.results.length, 1);
  assert.equal(res.violations.length, 0);
});

test('fanout › one worker rejects — violation collected, batch not aborted', async () => {
  const telemetryPath = await tempLedger();
  const good = () => Promise.resolve(makeReturn('good'));
  const bad = () => Promise.reject(new Error('worker crashed'));
  const res = await fanout([good, bad], { budgetClass: 'large', telemetryPath });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, 'good');
  assert.equal(res.violations.length, 1);
});

test('fanout › both workers are called (parallelism proof)', async () => {
  const telemetryPath = await tempLedger();
  let callCount = 0;
  const workers = [
    () => { callCount++; return Promise.resolve(makeReturn('p1')); },
    () => { callCount++; return Promise.resolve(makeReturn('p2')); },
  ];
  const res = await fanout(workers, { budgetClass: 'large', telemetryPath });
  assert.equal(callCount, 2, 'both workers must be invoked');
  assert.equal(res.results.length, 2);
});

test('fanout › timeout aborts the worker signal', async () => {
  const telemetryPath = await tempLedger();
  let aborted = false;

  /** @param {AbortSignal | undefined} signal */
  const slow = (signal) => new Promise((resolve) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
      resolve(makeReturn('slow'));
    }, { once: true });
  });

  const res = await fanout([slow], { budgetClass: 'large', timeoutMs: 20, telemetryPath });
  assert.equal(res.results.length, 0);
  assert.equal(res.violations.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
});

test('fanout › timeout with late AbortError rejection does not emit unhandledRejection', async () => {
  const telemetryPath = await tempLedger();
  /** @type {unknown[]} */
  const unhandled = [];
  /** @param {unknown} reason */
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };

  process.on('unhandledRejection', onUnhandled);
  try {
    /** @param {AbortSignal | undefined} signal */
    const abortRejectWorker = (signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        setTimeout(() => {
          const error = new Error('aborted after timeout');
          error.name = 'AbortError';
          reject(error);
        }, 0);
      }, { once: true });
    });

    const res = await fanout([abortRejectWorker], { budgetClass: 'large', timeoutMs: 20, telemetryPath });
    assert.equal(res.results.length, 0);
    assert.equal(res.violations.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('fanout › legacy zero-arg thunk still works', async () => {
  const telemetryPath = await tempLedger();
  const res = await fanout([() => Promise.resolve(makeReturn('legacy'))], { budgetClass: 'large', telemetryPath });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, 'legacy');
});

test('fanout › minSuccessRate floor marks insufficient when below threshold', async () => {
  const telemetryPath = await tempLedger();
  const workers = [
    () => Promise.resolve(makeReturn('ok-1')),
    () => Promise.resolve(makeReturn('ok-2')),
    () => Promise.resolve(makeReturn('bad-1', { confidence: 2 })),
    () => Promise.resolve(makeReturn('bad-2', { confidence: 3 })),
  ];

  const res = await fanout(workers, { budgetClass: 'large', minSuccessRate: 0.75, telemetryPath });
  assert.equal(res.planned, 4);
  assert.equal(res.succeeded, 2);
  assert.equal(res.insufficient, true);
});

test('fanout › minSuccessRate floor is not insufficient when threshold is met', async () => {
  const telemetryPath = await tempLedger();
  const workers = [
    () => Promise.resolve(makeReturn('ok-1')),
    () => Promise.resolve(makeReturn('ok-2')),
    () => Promise.resolve(makeReturn('ok-3')),
    () => Promise.resolve(makeReturn('ok-4')),
  ];

  const res = await fanout(workers, { budgetClass: 'large', minSuccessRate: 0.75, telemetryPath });
  assert.equal(res.planned, 4);
  assert.equal(res.succeeded, 4);
  assert.equal(res.insufficient, false);
});

test('fanout › minSuccessRate omitted keeps insufficient false even with zero successes', async () => {
  const telemetryPath = await tempLedger();
  const workers = [
    () => Promise.reject(new Error('crash')),
    () => Promise.reject(new Error('crash2')),
  ];

  const res = await fanout(workers, { budgetClass: 'large', telemetryPath });
  assert.equal(res.succeeded, 0);
  assert.equal(res.insufficient, false);
});

test('fanout › invalid minSuccessRate throws config error', async () => {
  await assert.rejects(
    () => fanout([() => Promise.resolve(makeReturn('ok'))], { budgetClass: 'large', minSuccessRate: 1.5 }),
    /minSuccessRate/
  );
});

test('fanout › dryRun includes succeeded and insufficient defaults', async () => {
  const res = await fanout([() => Promise.resolve(makeReturn('a'))], { budgetClass: 'large', dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.succeeded, 0);
  assert.equal(res.insufficient, false);
});

test('fanout › a worker that resolves synchronously on abort is still a timeout violation, never a success', async () => {
  // Pins the deadline-wins-the-race invariant: the TIMEOUT sentinel must be
  // resolved before the worker's abort-triggered resolution can settle
  // Promise.race, regardless of how quickly (even synchronously) the worker
  // reacts to the abort signal.
  const telemetryPath = await tempLedger();
  /** @param {AbortSignal | undefined} signal */
  const syncOnAbort = (signal) => new Promise((resolve) => {
    signal?.addEventListener('abort', () => {
      resolve(makeReturn('sync-on-abort'));
    }, { once: true });
  });

  const res = await fanout([syncOnAbort], { budgetClass: 'large', timeoutMs: 20, telemetryPath });
  assert.equal(res.results.length, 0);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0], 'worker-0');
});
