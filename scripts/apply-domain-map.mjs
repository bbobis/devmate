// @ts-check
// DN-4: apply a reviewed domain-map draft — the human-gate side of the
// generate → review → apply flow. Refuses to run without a draft (fail
// closed), validates the MERGED config through the DN-1 loader validation
// (an invalid draft is rejected naming the bad field), merges the draft's
// domains into devmate.config.json (existing ids updated, never duplicated,
// unrelated keys untouched), then copies the reviewed stubs to
// .devmate/contexts/. Re-applying the same draft is idempotent. Prints a
// digest only (TCM-9).
//
// Usage:
//   node scripts/apply-domain-map.mjs [--root <dir>]
import { join, resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveRepoRoot } from '../lib/init/repo-root.mjs';
import { validateDevmateConfig } from '../lib/config/devmate-config.mjs';
import { DRAFT_PATH, STUBS_DIR } from './generate-domain-map.mjs';
import {
  ensureDirSync,
  pathExists,
  readTextFileSync,
  writeTextFileSync,
} from '../lib/fs-safe.mjs';
import { parseJsonSafe } from '../lib/json-io.mjs';

/** Applied context files land here (the DN-1 contextFile convention). */
const CONTEXTS_DIR = '.devmate/contexts';

/** Config file the merge writes back to. */
const CONFIG_PATH = '.devmate/devmate.config.json';

/**
 * @param {string[]} args
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code (0 ok, 1 on failure — always fail closed)
 */
export async function main(args, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  try {
    const rootIdx = args.indexOf('--root');
    const rootVal = args.at(rootIdx + 1);
    const repoRoot =
      rootIdx !== -1 && rootVal ? resolve(rootVal) : await resolveRepoRoot(process.cwd());

    const draftAbs = join(repoRoot, DRAFT_PATH);
    if (!pathExists(draftAbs)) {
      err(`[devmate-map] no draft at ${DRAFT_PATH} — run scripts/generate-domain-map.mjs and review it first\n`);
      return 1;
    }
    const draftRaw = parseJsonSafe(readTextFileSync(draftAbs));
    const draft = /** @type {{ domains?: unknown }|null} */ (
      typeof draftRaw === 'object' ? draftRaw : null
    );
    if (draft === null || !Array.isArray(draft.domains)) {
      err(`[devmate-map] draft at ${DRAFT_PATH} is malformed: expected an object with a domains array\n`);
      return 1;
    }
    const draftDomains = /** @type {Record<string, unknown>[]} */ (draft.domains);

    const configAbs = join(repoRoot, CONFIG_PATH);
    if (!pathExists(configAbs)) {
      err(`[devmate-map] no ${CONFIG_PATH} — run devmate init before applying a domain map\n`);
      return 1;
    }
    const configRaw = parseJsonSafe(readTextFileSync(configAbs));
    if (configRaw === null || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
      err(`[devmate-map] ${CONFIG_PATH} is malformed JSON — fix it before applying\n`);
      return 1;
    }
    const config = /** @type {Record<string, unknown>} */ (configRaw);

    // Merge: existing ids are updated by the draft (shallow merge, draft
    // fields win), draft-only ids are appended in draft order, ids are never
    // duplicated, and every unrelated config key is preserved untouched.
    const existing = Array.isArray(config['domains'])
      ? /** @type {Record<string, unknown>[]} */ (config['domains'])
      : [];
    const draftById = new Map(draftDomains.map((d) => [d?.['domain'], d]));
    const merged = existing.map((e) => {
      const update = draftById.get(e?.['domain']);
      if (update === undefined) return e;
      draftById.delete(e?.['domain']);
      return { ...e, ...update };
    });
    for (const d of draftDomains) {
      if (draftById.has(d?.['domain'])) merged.push(d);
    }
    const mergedConfig = { ...config, domains: merged };

    // DN-1 validation on the MERGED result — an invalid draft is rejected
    // naming the bad field, and nothing is written.
    const validation = validateDevmateConfig(mergedConfig);
    if (!validation.ok) {
      err(`[devmate-map] draft rejected by config validation: ${validation.error}\n`);
      return 1;
    }

    writeTextFileSync(configAbs, `${JSON.stringify(mergedConfig, null, 2)}\n`);

    // Copy reviewed stubs to the live contexts dir (ids validated above).
    const contextsAbs = join(repoRoot, CONTEXTS_DIR);
    ensureDirSync(contextsAbs);
    let copied = 0;
    for (const d of draftDomains) {
      const id = d?.['domain'];
      if (typeof id !== 'string' || id === '') continue;
      const src = join(repoRoot, STUBS_DIR, `${id}.md`);
      if (!pathExists(src)) continue;
      writeTextFileSync(join(contextsAbs, `${id}.md`), readTextFileSync(src));
      copied += 1;
    }

    const updated = existing.filter((e) => draftDomains.some((d) => d?.['domain'] === e?.['domain'])).length;
    const added = merged.length - existing.length;
    out(
      `[devmate-map] merged ${draftDomains.length} draft domain(s) into ${CONFIG_PATH} ` +
        `(${updated} updated, ${added} added, ${merged.length} total)\n`,
    );
    out(`[devmate-map] copied ${copied} context stub(s) to ${CONTEXTS_DIR}/\n`);
    return 0;
  } catch (/** @type {unknown} */ e) {
    err(`[devmate-map] apply failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
