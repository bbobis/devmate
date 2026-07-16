// @ts-check
import { join } from 'node:path';
import { listDirEntries, pathExists, statPath } from '../fs-safe.mjs';

/**
 * Bounded set of stack signals read from a repo for persona inference.
 * @typedef {Object} RepoSignals
 * @property {string[]} topLevelDirs   Names of top-level directories.
 * @property {boolean}  hasPackageJson Whether a package manifest exists.
 * @property {boolean}  hasTsconfig    Whether a TypeScript config exists.
 * @property {boolean}  hasJavaBuild   Whether a Java build file exists (pom.xml or build.gradle).
 * @property {string[]} srcSubdirs     Notable subdirectories under src/ (e.g. main/java, ui).
 * @property {string[]} srcChildren    Immediate child directory names under src/ (sorted). Grounds persona globs in the real layout.
 */

/**
 * A small, fixed set of notable src/ subdir paths we probe for. Kept tiny so
 * the scan stays bounded and never recurses the whole tree.
 * @type {string[]}
 */
const NOTABLE_SRC_SUBDIRS = [
  'main/java',
  'test/java',
  'main',
  'test',
  'ui',
  'components',
  'app',
  'pages',
];

/**
 * Read a bounded set of signals from the repo: the top-level directory names,
 * a handful of well-known marker files, and a fixed probe of notable src/
 * subdirectories. Intentionally does NOT read the whole repo — this keeps
 * inference cheap and token-lean.
 *
 * @param {string} repoRoot  Absolute path to the repo root.
 * @returns {Promise<RepoSignals>}
 */
export async function scanRepoSignals(repoRoot) {
  const topLevelDirs = await listTopLevelDirs(repoRoot);

  const hasPackageJson = pathExists(join(repoRoot, 'package.json'));
  const hasTsconfig = pathExists(join(repoRoot, 'tsconfig.json'));
  const hasJavaBuild =
    pathExists(join(repoRoot, 'pom.xml')) || pathExists(join(repoRoot, 'build.gradle'));

  const srcSubdirs = await probeSrcSubdirs(repoRoot);
  const srcChildren = await listSrcChildren(repoRoot);

  return { topLevelDirs, hasPackageJson, hasTsconfig, hasJavaBuild, srcSubdirs, srcChildren };
}

/**
 * List immediate child directory names under `src/` (sorted). Returns [] when
 * there is no `src/` dir or on any error. One readdir — never recurses.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
async function listSrcChildren(repoRoot) {
  const srcRoot = join(repoRoot, 'src');
  try {
    const entries = await listDirEntries(srcRoot);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * List immediate child directory names of `repoRoot`. Returns [] on any error.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
async function listTopLevelDirs(repoRoot) {
  try {
    const entries = await listDirEntries(repoRoot);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * Probe a fixed list of notable subdirectories under src/ and return those
 * that exist (as paths relative to src/). Bounded — never recurses.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
async function probeSrcSubdirs(repoRoot) {
  const srcRoot = join(repoRoot, 'src');
  if (!(await isDir(srcRoot))) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  for (const sub of NOTABLE_SRC_SUBDIRS) {
    if (await isDir(join(srcRoot, sub))) {
      found.push(sub);
    }
  }
  return found;
}

/**
 * True if `p` exists and is a directory.
 * @param {string} p  Absolute path.
 * @returns {Promise<boolean>}
 */
async function isDir(p) {
  try {
    const s = await statPath(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
