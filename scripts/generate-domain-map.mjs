// @ts-check
// DN-4: generate a DRAFT business-domain map + per-domain context-file stubs
// from repo structure. Drafts land ONLY under .devmate/session/ — this script
// never touches devmate.config.json or .devmate/contexts/; the human reviews
// and then scripts/apply-domain-map.mjs applies (the spec-artifact
// draft→confirm pattern). Prints a digest only (counts, ids, paths) — never
// file contents (TCM-9).
//
// Usage:
//   node scripts/generate-domain-map.mjs [--root <dir>]
import { dirname, join, relative, resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveRepoRoot } from '../lib/init/repo-root.mjs';
import { walkRepoFiles } from '../lib/discovery/scan.mjs';
import {
  inferDomains,
  MAX_INFERRED_DOMAINS,
} from '../lib/init/infer-domains.mjs';
import {
  ensureDirSync,
  pathExists,
  readTextFileSync,
  writeTextFileSync,
} from '../lib/fs-safe.mjs';
import { parseJsonSafe } from '../lib/json-io.mjs';

/** Draft artifact paths, relative to the repo root (documented in the skill). */
export const DRAFT_PATH = '.devmate/session/domain-map-draft.json';
export const STUBS_DIR = '.devmate/session/domain-contexts-draft';

/** FO-3's optional candidate-scan artifact — a seed, never a requirement. */
const CANDIDATES_PATH = '.devmate/state/discovery-candidates.json';

/**
 * @param {string[]} args
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code (0 ok, 1 on failure)
 */
export async function main(args, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  try {
    const rootIdx = args.indexOf('--root');
    const rootVal = args.at(rootIdx + 1);
    const repoRoot =
      rootIdx !== -1 && rootVal ? resolve(rootVal) : await resolveRepoRoot(process.cwd());

    const absFiles = await walkRepoFiles(repoRoot);
    const fileList = absFiles
      .map((p) => relative(repoRoot, p).split('\\').join('/'))
      .sort();

    // FO-3 seed (optional): malformed or absent is the first-class null branch.
    /** @type {object|null} */
    let candidatesArtifact = null;
    const candidatesAbs = join(repoRoot, CANDIDATES_PATH);
    if (pathExists(candidatesAbs)) {
      try {
        const parsed = parseJsonSafe(readTextFileSync(candidatesAbs));
        candidatesArtifact = typeof parsed === 'object' ? parsed : null;
      } catch {
        candidatesArtifact = null;
      }
    }

    const { domains, stubs, droppedDomains } = inferDomains({
      repoRoot,
      fileList,
      candidatesArtifact,
    });

    const draftAbs = join(repoRoot, DRAFT_PATH);
    ensureDirSync(dirname(draftAbs));
    writeTextFileSync(draftAbs, `${JSON.stringify({ schemaVersion: 1, domains }, null, 2)}\n`);

    const stubsDirAbs = join(repoRoot, STUBS_DIR);
    ensureDirSync(stubsDirAbs);
    for (const [id, content] of Object.entries(stubs)) {
      // ids are kebab-cased by the inferrer, so the joined name is path-safe.
      writeTextFileSync(join(stubsDirAbs, `${id}.md`), content);
    }

    const ids = domains.map((d) => d.domain);
    out(`[devmate-map] draft: ${domains.length} domain(s)${ids.length > 0 ? `: ${ids.join(', ')}` : ''}\n`);
    out(`[devmate-map] wrote ${DRAFT_PATH} and ${Object.keys(stubs).length} stub(s) under ${STUBS_DIR}/\n`);
    if (droppedDomains.length > 0) {
      out(
        `[devmate-map] warning: kept the ${MAX_INFERRED_DOMAINS} largest domains; dropped: ${droppedDomains.join(', ')}\n`,
      );
    }
    out('[devmate-map] review and edit the draft, then apply it with scripts/apply-domain-map.mjs\n');
    return 0;
  } catch (/** @type {unknown} */ e) {
    err(`[devmate-map] generate failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
