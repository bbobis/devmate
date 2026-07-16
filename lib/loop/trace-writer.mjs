// @ts-check

/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */

import { dirname } from 'node:path';
import { appendTextFile, ensureDir } from '../fs-safe.mjs';
import { validateTraceEvent } from './trace-schema.mjs';

/**
 * Validate then atomically append a trace event as a JSONL line.
 * @param {string} filePath
 * @param {AnyLoopEvent} event
 * @returns {Promise<void>}
 */
export async function appendTraceEvent(filePath, event) {
  const result = validateTraceEvent(event);
  if (!result.ok) {
    throw new Error(`Invalid loop trace event: ${result.errors.join('; ')}`);
  }
  await ensureDir(dirname(filePath));
  await appendTextFile(filePath, JSON.stringify(event) + '\n');
}
