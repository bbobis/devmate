// @ts-check

/**
 * E6-4: In-process append serializer for trace files.
 *
 * `withAppendLock` chains async functions that touch the same file path so
 * that a read-modify-write append (count lines, then append) can never
 * interleave with another append to the same file in the same process.
 *
 * Scope: in-process only. It does NOT coordinate across separate OS
 * processes — that is intentionally out of scope here. Cross-process safety
 * for the memory ledger is handled separately by lib/memory/jsonl-lock.mjs.
 *
 * Mechanism: a module-level Map keyed by file path holds the "tail" promise
 * for that path. Each new call attaches its work to the tail, so calls run
 * strictly first-in, first-out (FIFO). The tail is cleaned up once it is the
 * last one in the chain, so the Map does not grow without bound.
 */

/**
 * Per-path tail promise. Resolves when all currently-queued work for that
 * path has finished. Absent entry means the path is idle.
 * @type {Map<string, Promise<void>>}
 */
const tails = new Map();

/**
 * Run `fn` exclusively with respect to other `withAppendLock` calls that use
 * the same `filePath`, in FIFO order. Returns whatever `fn` resolves to.
 *
 * @template T
 * @param {string} filePath Key identifying the contended resource.
 * @param {() => Promise<T>} fn The critical-section work to run.
 * @returns {Promise<T>}
 */
export function withAppendLock(filePath, fn) {
  // The previous tail (or an already-resolved promise if the path is idle).
  const prev = tails.get(filePath) ?? Promise.resolve();

  // Our work runs only after `prev` settles (success OR failure), so a
  // rejected predecessor never blocks the queue.
  const run = prev.then(fn, fn);

  // The new tail resolves when our work settles, regardless of outcome, so
  // the next caller is not blocked by our rejection.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(filePath, tail);

  // Self-cleanup: when our tail settles, drop the Map entry only if it is
  // still ours (no later caller appended a newer tail).
  tail.then(() => {
    if (tails.get(filePath) === tail) {
      tails.delete(filePath);
    }
  });

  return run;
}
