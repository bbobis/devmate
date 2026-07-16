// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { generateJsonSchema } from '../lib/loop/trace-schema.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUTPUT_PATH = 'docs/loop-trace-schema.json';

/**
 * Generate (or check) the loop trace JSON schema artifact.
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  const checkMode = args.includes('--check');

  const schema = generateJsonSchema();
  const generated = JSON.stringify(schema, null, 2) + '\n';

  if (checkMode && existsSync(OUTPUT_PATH)) {
    const existing = readFileSync(OUTPUT_PATH, 'utf8');
    if (existing === generated) {
      process.stdout.write(`${OUTPUT_PATH} is up to date.\n`);
      return 0;
    }
    process.stderr.write(`${OUTPUT_PATH} is out of date. Run: node scripts/generate-loop-schema.mjs\n`);
    return 1;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, generated, 'utf8');
  process.stdout.write(`Written: ${OUTPUT_PATH}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
