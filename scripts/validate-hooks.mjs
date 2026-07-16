// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { loadHookManifest, validateHookManifest } from '../lib/hooks/registry.mjs';

/**
 * CI entrypoint: load hooks/hooks.json, validate it, print pass/fail summary.
 * Exits 0 on valid manifest, 1 on errors or load failure.
 * @param {string[]} _args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  let manifest;
  try {
    manifest = loadHookManifest();
  } catch (/** @type {any} */ err) {
    process.stderr.write(`[validate-hooks] FAIL — could not load manifest: ${err.message}\n`);
    return 1;
  }

  const result = validateHookManifest(manifest);

  if (result.ok) {
    process.stdout.write('[validate-hooks] PASS — hooks manifest is valid.\n');
    return 0;
  }

  process.stderr.write('[validate-hooks] FAIL — manifest has errors:\n');
  for (const err of result.errors) {
    process.stderr.write(`  - ${err}\n`);
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}