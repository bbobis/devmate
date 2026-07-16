// @ts-check
// CI lint over hook/script entrypoints. Two independent checks:
//
//  1. No `.mjs` in the tree may compare import.meta.url against a hand-built
//     file:// string as its entry guard — that comparison is always false on
//     Windows, so main() silently never runs (issue #48).
//
//  2. Every command registered in hooks/hooks.json must resolve to a file that
//     exports main() AND self-invokes. Check 1 only finds a *broken* guard; a
//     file with no guard at all is invisible to it — which is how
//     hooks/spec-integrity-guard.mjs stayed registered-but-inert, leaving the
//     human spec-approval gate unprotected (issue #75).
//
// Both failure modes are the same disease: a hook the manifest and the docs
// both claim is enforcing something, which in production does nothing at all.
// Thin I/O wrapper around lib/entry-guard-lint.mjs.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import {
  findBrokenEntryGuards,
  findUnrunnableHooks,
  formatEntryGuardTable,
  formatUnrunnableHookTable,
} from '../lib/entry-guard-lint.mjs';
import { extractScriptPath, loadHookManifest } from '../lib/hooks/registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * CI entrypoint. Exits 0 when every entry guard is cross-platform AND every
 * registered hook can actually execute; 1 otherwise.
 * @param {string[]} _args  CLI args (unused).
 * @param {{ rootOverride?: string }} [opts]  Test overrides.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;
  let failed = false;

  const broken = await findBrokenEntryGuards(root);
  if (broken.length > 0) {
    failed = true;
    process.stderr.write(
      `[check-entrypoint-guard] FAIL — ${broken.length} Windows-broken entry guard(s). ` +
        'Comparing import.meta.url against a hand-built file:// string never matches on Windows, ' +
        'so main() silently never runs (see the Fix column below).\n'
    );
    process.stderr.write(formatEntryGuardTable(broken) + '\n');
  }

  const unrunnable = findUnrunnableHooks(root, {
    loadManifest: (r) => loadHookManifest(r),
    extractScriptPath,
  });
  if (unrunnable.length > 0) {
    failed = true;
    process.stderr.write(
      `[check-entrypoint-guard] FAIL — ${unrunnable.length} registered hook(s) cannot execute. ` +
        'A hook listed in hooks/hooks.json that exports no main() or never self-invokes is spawned, ' +
        'loads, and exits 0 having done nothing — a silent, total failure of that enforcement layer.\n'
    );
    process.stderr.write(formatUnrunnableHookTable(unrunnable) + '\n');
  }

  if (failed) return 1;

  process.stdout.write(
    '[check-entrypoint-guard] PASS — every entry guard is cross-platform and every registered hook can run.\n'
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
