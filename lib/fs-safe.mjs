// @ts-check
// Audited filesystem choke point.
//
// devmate is a local dev tool whose file access is, by design, always a
// computed path: join(repoRoot | tmpdir, CONSTANT[, validated segment]). The
// security/detect-non-literal-fs-filename rule has no options and no taint
// analysis, so it flags every such call identically (~270 sites before this
// module existed). Per-line disables at that volume were reviewed and
// rejected; instead ALL production fs access goes through these wrappers, so
// the rule keeps watching the rest of lib/, scripts/, and hooks/ (any new
// direct node:fs use still warns) while the unavoidable disables live in one
// reviewable file.
//
// Trust contract for callers:
// - Paths must be built from a trusted root (repoRoot, tmpdir) plus constant
//   segments; any dynamic segment must be validated first (see validateTaskId
//   in lib/memory/paths.mjs) or containment-checked with assertWithinRoot().
// - Wrappers are deliberately thin: identical arguments-to-behavior mapping,
//   utf8 text encoding, errors propagate unchanged.
//
// Deliberate exceptions that stay on raw node:fs (with their own justified
// disables): the O_EXCL lock acquisition in lib/file-lock.mjs and
// lib/memory/jsonl-lock.mjs, where the exclusive-create flag IS the locking
// semantics.
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * Resolve `p` against `root` and throw if the result escapes `root`.
 * Returns the resolved absolute path on success.
 * @param {string} root
 * @param {string} p  Absolute or root-relative path.
 * @returns {string}
 */
export function assertWithinRoot(root, p) {
  const base = resolve(root);
  const abs = resolve(base, p);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path escapes root: ${p}`);
  }
  return abs;
}

// ── async (node:fs/promises) ────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readTextFile(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readFile(filePath, 'utf8');
}

/**
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeTextFile(filePath, text) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return writeFile(filePath, text, 'utf8');
}

/**
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function appendTextFile(filePath, text) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return appendFile(filePath, text, 'utf8');
}

/**
 * mkdir -p.
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
export async function ensureDir(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  await mkdir(dirPath, { recursive: true });
}

/**
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
export async function listDir(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readdir(dirPath);
}

/**
 * @param {string} dirPath
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
export async function listDirEntries(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readdir(dirPath, { withFileTypes: true });
}

/**
 * @param {string} targetPath
 * @returns {Promise<import('node:fs').Stats>}
 */
export async function statPath(targetPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return stat(targetPath);
}

/**
 * @param {string} fromPath
 * @param {string} toPath
 * @returns {Promise<void>}
 */
export async function renamePath(fromPath, toPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return rename(fromPath, toPath);
}

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function removeFile(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return unlink(filePath);
}

// ── sync (node:fs) ──────────────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @returns {string}
 */
export function readTextFileSync(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readFileSync(filePath, 'utf8');
}

/**
 * @param {string} filePath
 * @param {string} text
 * @returns {void}
 */
export function writeTextFileSync(filePath, text) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  writeFileSync(filePath, text, 'utf8');
}

/**
 * @param {string} filePath
 * @param {string} text
 * @returns {void}
 */
export function appendTextFileSync(filePath, text) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  appendFileSync(filePath, text, 'utf8');
}

/**
 * mkdir -p, sync.
 * @param {string} dirPath
 * @returns {void}
 */
export function ensureDirSync(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  mkdirSync(dirPath, { recursive: true });
}

/**
 * @param {string} targetPath
 * @returns {boolean}
 */
export function pathExists(targetPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return existsSync(targetPath);
}

/**
 * @param {string} dirPath
 * @returns {string[]}
 */
export function listDirSync(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readdirSync(dirPath);
}

/**
 * @param {string} dirPath
 * @returns {import('node:fs').Dirent[]}
 */
export function listDirEntriesSync(dirPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return readdirSync(dirPath, { withFileTypes: true });
}

/**
 * @param {string} targetPath
 * @returns {import('node:fs').Stats}
 */
export function statPathSync(targetPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return statSync(targetPath);
}

/**
 * @param {string} fromPath
 * @param {string} toPath
 * @returns {void}
 */
export function renamePathSync(fromPath, toPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  renameSync(fromPath, toPath);
}

/**
 * @param {string} filePath
 * @returns {void}
 */
export function removeFileSync(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  unlinkSync(filePath);
}

/**
 * Byte stream for line-by-line readers (readline.createInterface input).
 * @param {string} filePath
 * @returns {import('node:fs').ReadStream}
 */
export function openReadStream(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited choke point; see module header.
  return createReadStream(filePath);
}
