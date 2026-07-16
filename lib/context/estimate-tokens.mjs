// @ts-check
// E9-09: the single shared token estimator. Every budget subsystem
// (file budgets, session budget, loop cost tracker) must estimate through
// this one canonical unit so their numbers are comparable.
import { Buffer } from 'node:buffer';

/**
 * Canonical bytes-per-token divisor.
 * TODO: calibrate after E9-22 baselines — 4 bytes/token and the ±20% bound are provisional
 */
const BYTES_PER_TOKEN = 4;

/**
 * Estimate tokens for text using a single canonical unit (UTF-8 bytes / 4).
 * Documented error bound: ~±20% vs a real BPE tokenizer on mixed content.
 * @param {string | number} textOrBytes  Text, or a precomputed UTF-8 byte length.
 * @returns {number} Estimated tokens (ceil).
 */
export function estimateTokens(textOrBytes) {
  const bytes = typeof textOrBytes === 'number' ? textOrBytes : Buffer.byteLength(textOrBytes, 'utf8');
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}
