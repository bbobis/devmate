// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { routeLearnCommand } from '../lib/workflow/learn.mjs';

/**
 * `learn-router` entrypoint. Classifies a learn invocation as read-only `help`
 * or gated `pattern-authoring`, and prints the route ONLY. It performs no file
 * writes — the calling agent uses the route to pick the right sub-agent.
 *
 * Flags:
 *   --input <text>   The user's learn invocation text.
 *
 * Exit: always 0 (routing is informational). Defaults to 'help' on empty input.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let input = '';
  const iIdx = args.indexOf('--input');
  const iVal = args.at(iIdx + 1);
  if (iIdx !== -1 && iVal) input = iVal;

  const route = routeLearnCommand(input);
  process.stdout.write(JSON.stringify({ route }) + '\n');
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
