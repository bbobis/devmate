// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { readTextFile, writeTextFile } from '../lib/fs-safe.mjs';
import { reduceEvidencePack } from '../lib/context/context-reducer.mjs';

/** @typedef {import('../lib/types.mjs').EvidencePack} EvidencePack */
/** @typedef {import('../lib/types.mjs').ReducedPack} ReducedPack */

/**
 * E4-3: `reduce-context` — agent-invoked ContextReducer CLI.
 *
 * Reads an EvidencePack JSON file, runs the MapReduce reduction, and writes a
 * ReducedPack JSON artifact. Prints a one-line summary to stdout.
 *
 * Usage:
 *   node scripts/reduce-context.mjs <input.json> [output.json]
 *
 * `output.json` defaults to `<input>-reduced.json`. A pack that is already
 * within its maxSources budget produces no reduction; the script reports that
 * and still exits 0.
 *
 * Exit: 0 on success; 1 on any error (compact message unless DEBUG=1).
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const inputPath = args[0];
  if (!inputPath) {
    process.stderr.write('reduce-context: missing input pack path\n');
    return 1;
  }
  const outputPath = args[1] || inputPath.replace(/\.json$/i, '') + '-reduced.json';

  try {
    const raw = await readTextFile(inputPath);
    /** @type {EvidencePack} */
    const pack = JSON.parse(raw);

    const reduced = await reduceEvidencePack(pack);
    if (reduced === null) {
      process.stdout.write(
        `No reduction needed: ${pack.pointers.length} pointers within maxSources=${pack.maxSources}\n`,
      );
      return 0;
    }

    await writeTextFile(outputPath, JSON.stringify(reduced) + '\n');
    process.stdout.write(
      `Reduced ${reduced.originalCount} pointers → ${reduced.chunks.length} chunks\n`,
    );
    return 0;
  } catch (/** @type {unknown} */ err) {
    if (process.env.DEBUG === '1') {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    } else {
      process.stderr.write(`reduce-context: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
