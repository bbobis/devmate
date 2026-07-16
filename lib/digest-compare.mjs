// @ts-check
// Constant-time digest comparison.
//
// The digests compared in this codebase are change-detection fingerprints for
// local files (has the spec changed since it was approved?), not
// authentication secrets — there is no timing-attack surface. timingSafeEqual
// costs nothing here, though, and using it keeps every digest comparison in
// one audited helper instead of scattering per-site lint suppressions for
// CWE-208 checkers.
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality for digest strings. Returns false when either side
 * is not a string (absent/never-recorded digests compare unequal).
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
