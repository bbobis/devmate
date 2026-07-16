// @ts-check
/**
 * Issue #21: the lock modules under REAL write contention.
 *
 * The fork-race E2E (test/e2e/host-history-resilience.e2e.test.mjs) drives
 * two sessions lock-step — each hook spawn is a barrier — per issue #7's own
 * directive, so its "no torn writes" oracle is structural-serialization-only:
 * it would pass with the lock modules deleted. These tests close that gap
 * where determinism is cheap: in-process, overlapping async writers, no
 * subprocess scheduling. Every case here FAILS if its lock is replaced with
 * a no-op (verified while authoring by stubbing the lock out).
 *
 * Scope matches the modules' own contracts: `withFileLock` is O_EXCL-based
 * mutual exclusion around a critical section; `withAppendLock` is the
 * IN-PROCESS FIFO serializer for trace appends (cross-process ledger safety
 * is lib/memory/jsonl-lock.mjs's job, out of scope here — as its header
 * says).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LOCK_SUFFIX, withFileLock } from '../../lib/file-lock.mjs';
import { withAppendLock } from '../../lib/trace/lock.mjs';
import { appendTraceEvent, traceFilePath } from '../../lib/trace/append.mjs';

/** Concurrent writers per contention case — enough overlap to matter, small
 * enough to stay fast and deterministic. */
const WRITERS = 8;

/** @type {string[]} */
// @bounded-alloc — one temp dir per test in this file.
const tmpDirs = [];

/** @returns {string} a fresh tmp dir, cleaned up after the run. */
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-contention-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Yield the event loop so overlapping writers genuinely interleave. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

test('withFileLock › N overlapping read-modify-write writers lose no update', async () => {
  // The real consumers' pattern (lib/task-state.mjs writeTaskState): the
  // critical section reads the current file, derives the next state, writes
  // it back. Without mutual exclusion, two writers read the same counter and
  // one increment vanishes — the classic lost update. N=8 overlapping
  // writers must land ALL N increments.
  const dir = makeTmpDir();
  const dataPath = join(dir, 'state.json');
  const lockPath = dataPath + LOCK_SUFFIX;
  writeFileSync(dataPath, JSON.stringify({ counter: 0 }), 'utf8');

  /** @type {Promise<import('../../lib/types.mjs').LockResult>[]} */
  // @bounded-alloc — one entry per writer (WRITERS = 8).
  const writers = [];
  for (let i = 0; i < WRITERS; i++) {
    writers.push(
      withFileLock(
        lockPath,
        async () => {
          const current = JSON.parse(readFileSync(dataPath, 'utf8'));
          // Hold the lock across an event-loop turn so every other writer is
          // genuinely waiting on the lock, not merely scheduled later.
          await tick();
          writeFileSync(dataPath, JSON.stringify({ counter: current.counter + 1 }), 'utf8');
        },
        { retryIntervalMs: 2 },
      ),
    );
  }
  const results = await Promise.all(writers);

  for (const r of results) {
    assert.equal(r.acquired, true, `a writer failed to acquire: ${'error' in r ? r.error : ''}`);
  }
  const final = JSON.parse(readFileSync(dataPath, 'utf8'));
  assert.equal(final.counter, WRITERS, `lost update: ${WRITERS} writers landed ${final.counter} increments`);
});

test('withFileLock › a concurrent reader never observes a torn or half-applied file', async () => {
  const dir = makeTmpDir();
  const dataPath = join(dir, 'state.json');
  const lockPath = dataPath + LOCK_SUFFIX;
  writeFileSync(dataPath, JSON.stringify({ counter: 0, pad: 'x'.repeat(512) }), 'utf8');

  let writersDone = false;
  /** @type {Promise<unknown>[]} */
  // @bounded-alloc — WRITERS lock writers plus one polling reader.
  const work = [];
  for (let i = 0; i < WRITERS; i++) {
    work.push(
      withFileLock(
        lockPath,
        async () => {
          const current = JSON.parse(readFileSync(dataPath, 'utf8'));
          await tick();
          writeFileSync(
            dataPath,
            JSON.stringify({ counter: current.counter + 1, pad: 'x'.repeat(512) }),
            'utf8',
          );
        },
        { retryIntervalMs: 2 },
      ),
    );
  }

  // The reader polls the whole time the writers contend: every observed
  // state must parse and carry the invariant shape.
  work.push(
    (async () => {
      let observations = 0;
      while (!writersDone) {
        const parsed = JSON.parse(readFileSync(dataPath, 'utf8')); // throws on a torn file
        assert.equal(typeof parsed.counter, 'number', 'observed a half-applied state');
        observations += 1;
        await tick();
      }
      assert.ok(observations > 0, 'the reader never actually observed anything');
    })(),
  );

  await Promise.all(work.slice(0, WRITERS)).then(() => {
    writersDone = true;
  });
  await Promise.all(work);

  assert.equal(JSON.parse(readFileSync(dataPath, 'utf8')).counter, WRITERS);
});

test('withFileLock › a waiter runs strictly after the holder releases, never inside its window', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json') + LOCK_SUFFIX;
  /** @type {string[]} */
  // @bounded-alloc — four ordering markers.
  const order = [];

  const holder = withFileLock(
    lockPath,
    async () => {
      order.push('holder-enter');
      // Hold across several event-loop turns while the waiter retries.
      for (let i = 0; i < 5; i++) await tick();
      order.push('holder-exit');
    },
    { retryIntervalMs: 2 },
  );
  // Give the holder a head start so the waiter's first acquire attempt
  // happens INSIDE the held window.
  await tick();
  const waiter = withFileLock(
    lockPath,
    () => {
      order.push('waiter-enter');
    },
    { retryIntervalMs: 2 },
  );

  const [h, w] = await Promise.all([holder, waiter]);
  assert.equal(h.acquired, true);
  assert.equal(w.acquired, true);
  assert.deepEqual(
    order,
    ['holder-enter', 'holder-exit', 'waiter-enter'],
    'the waiter entered the critical section while the holder still held the lock',
  );
});

test('withAppendLock › overlapping read-count-then-append cycles stay FIFO and lose nothing', async () => {
  // The trace appender's pattern (lib/trace/append.mjs): count existing
  // lines, then append line N+1. Interleaved, two appenders would both
  // count N and one line number would repeat.
  const dir = makeTmpDir();
  const filePath = join(dir, 'trace.jsonl');
  writeFileSync(filePath, '', 'utf8');

  /** @type {Promise<unknown>[]} */
  // @bounded-alloc — one entry per appender (WRITERS = 8).
  const appenders = [];
  for (let i = 0; i < WRITERS; i++) {
    appenders.push(
      withAppendLock(filePath, async () => {
        const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l !== '');
        await tick(); // widen the read-append window
        writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${JSON.stringify({ line: lines.length + 1, writer: i })}\n`, 'utf8');
      }),
    );
  }
  await Promise.all(appenders);

  const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l !== '');
  assert.equal(lines.length, WRITERS, `interleaved appends lost lines: ${lines.length}/${WRITERS}`);
  lines.forEach((line, idx) => {
    const parsed = JSON.parse(line); // throws on an interleaved partial line
    assert.equal(parsed.line, idx + 1, `line numbering shows a lost or duplicated count at index ${idx}`);
  });
  // FIFO: writers were queued 0..N-1 and must have appended in that order.
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).writer),
    Array.from({ length: WRITERS }, (_, i) => i),
    'withAppendLock did not serialize appenders first-in first-out',
  );
});

test('appendTraceEvent › N overlapping appends yield exactly N intact, correctly numbered lines', async () => {
  // The full production path: schema validation + line counting + append,
  // serialized per file by withAppendLock. Every event must land whole and
  // the reported lineNumbers must be exactly 1..N with no repeats.
  const root = makeTmpDir();
  const taskId = 'contention-task';

  /** @type {Promise<{ ok: boolean, lineNumber?: number, errors?: string[] }>[]} */
  // @bounded-alloc — one entry per appender (WRITERS = 8).
  const appends = [];
  for (let i = 0; i < WRITERS; i++) {
    appends.push(
      appendTraceEvent(
        {
          type: 'action',
          actionType: 'write',
          path: `src/file-${i}.mjs`,
          digest: `sha256:${String(i).repeat(4)}`,
          stepId: `step-${i}`,
          taskId,
          ts: '2026-01-01T00:00:00.000Z',
          schemaVersion: 1,
        },
        { root },
      ),
    );
  }
  const results = await Promise.all(appends);

  for (const r of results) {
    assert.equal(r.ok, true, `an append failed under contention: ${(r.errors ?? []).join('; ')}`);
  }
  const lineNumbers = results.map((r) => r.lineNumber).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(
    lineNumbers,
    Array.from({ length: WRITERS }, (_, i) => i + 1),
    'line numbers must be exactly 1..N — a repeat means two appenders counted the same tail',
  );

  const raw = readFileSync(traceFilePath(taskId, root), 'utf8');
  const lines = raw.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, WRITERS, 'the trace file lost or gained lines under contention');
  for (const line of lines) {
    JSON.parse(line); // throws on an interleaved partial line
  }
});

test('withAppendLock › a rejecting appender does not block or reorder the queue behind it', async () => {
  const dir = makeTmpDir();
  const filePath = join(dir, 'trace.jsonl');
  /** @type {string[]} */
  // @bounded-alloc — three ordering markers.
  const order = [];

  const first = withAppendLock(filePath, async () => {
    order.push('first');
    await tick();
    throw new Error('boom');
  });
  const second = withAppendLock(filePath, async () => {
    order.push('second');
  });

  await assert.rejects(first, /boom/);
  await second;
  assert.deepEqual(order, ['first', 'second'], 'the rejected appender blocked or reordered its successor');
});
