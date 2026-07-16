// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';

/**
 * Hook handler: PostToolUse.
 * Reads the hook payload from stdin and processes it.
 * Filters internally on hook_event_name / tool_name — matchers are not relied upon.
 * @param {string[]} _args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  // Stub: real implementation added in subsequent issues.
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}