// @ts-check
import { pathToFileURL } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { main as initMain } from './init.mjs';

/**
 * Backward-compatible entrypoint alias for `devmate init`.
 * Delegates to scripts/init.mjs and preserves its CLI contract.
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  return initMain(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
