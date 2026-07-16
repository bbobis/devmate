// @ts-check
// Pure logic behind scripts/check-contract-drift.mjs: EOL-normalized hashing
// and cross-repo diffing of the shared devmate ⇄ monoroot contract files (the
// vendored schemas + fixtures corpora). Deterministic — same file contents
// yield the same hash on every platform regardless of checkout line endings.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { listDirEntriesSync, pathExists, readTextFileSync, statPathSync } from './fs-safe.mjs';

/**
 * A file participating in a contract hash: a stable repo-relative key (POSIX
 * separators) plus its EOL-normalized content.
 * @typedef {Object} ContractFile
 * @property {string} key
 * @property {string} content
 */

/**
 * One shared local ⇄ sibling path pair (file or directory) of a contract.
 * @typedef {Object} SharedEntry
 * @property {string} local    Repo-relative path in devmate.
 * @property {string} sibling  Repo-relative path in monoroot.
 */

/**
 * Normalize CRLF/CR line endings to LF so hashes and diffs are checkout- and
 * platform-independent.
 * @param {string} text
 * @returns {string}
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Recursively list every file under `absDir` as sorted POSIX-style relative
 * paths. Returns [] when the directory does not exist.
 * @param {string} absDir
 * @returns {string[]}
 */
export function listFilesUnder(absDir) {
  if (!pathExists(absDir) || !statPathSync(absDir).isDirectory()) {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} dir
   * @param {string} prefix
   */
  const walk = (dir, prefix) => {
    for (const entry of listDirEntriesSync(dir)) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(absDir, '');
  return out.sort();
}

/**
 * Collect the contract files for a set of repo-relative paths (files or
 * directories, expanded recursively), keyed by POSIX-style relative path and
 * sorted by key. A missing path contributes nothing — the caller decides
 * whether that is an error (the in-repo hash simply won't match).
 * @param {string} rootDir       Absolute repo root.
 * @param {string[]} localPaths  Repo-relative files/directories.
 * @returns {ContractFile[]}
 */
export function collectContractFiles(rootDir, localPaths) {
  /** @type {ContractFile[]} */
  const files = [];
  for (const localPath of localPaths) {
    const abs = join(rootDir, localPath);
    if (!pathExists(abs)) {
      continue;
    }
    if (statPathSync(abs).isDirectory()) {
      for (const rel of listFilesUnder(abs)) {
        files.push({ key: `${localPath}/${rel}`, content: normalizeEol(readTextFileSync(join(abs, rel))) });
      }
    } else {
      files.push({ key: localPath, content: normalizeEol(readTextFileSync(abs)) });
    }
  }
  return files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * SHA-256 over the sorted key+content sequence. Keys are included so a file
 * rename (not just a content edit) changes the hash; a NUL separator keeps
 * adjacent entries from concatenating ambiguously.
 * @param {ContractFile[]} files
 * @returns {string} lowercase hex digest
 */
export function hashContractFiles(files) {
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.key);
    hash.update('\n');
    hash.update(f.content);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * EOL-normalized comparison of one shared local ⇄ sibling entry. Returns
 * human-readable problem strings; empty = the shared bytes agree.
 * @param {string} localRoot    Absolute devmate repo root.
 * @param {string} siblingRoot  Absolute monoroot repo root.
 * @param {SharedEntry} entry
 * @returns {string[]}
 */
export function compareSharedEntry(localRoot, siblingRoot, entry) {
  /** @type {string[]} */
  const problems = [];
  const localAbs = join(localRoot, entry.local);
  const siblingAbs = join(siblingRoot, entry.sibling);

  if (!pathExists(localAbs)) {
    problems.push(`local ${entry.local} is missing`);
    return problems;
  }
  if (!pathExists(siblingAbs)) {
    problems.push(`sibling ${entry.sibling} is missing`);
    return problems;
  }

  const localIsDir = statPathSync(localAbs).isDirectory();
  const siblingIsDir = statPathSync(siblingAbs).isDirectory();
  if (localIsDir !== siblingIsDir) {
    problems.push(`${entry.local} and sibling ${entry.sibling} are not the same kind (file vs directory)`);
    return problems;
  }

  if (!localIsDir) {
    if (normalizeEol(readTextFileSync(localAbs)) !== normalizeEol(readTextFileSync(siblingAbs))) {
      problems.push(`${entry.local} differs from sibling ${entry.sibling}`);
    }
    return problems;
  }

  const localFiles = listFilesUnder(localAbs);
  const siblingFiles = listFilesUnder(siblingAbs);
  const union = [...new Set([...localFiles, ...siblingFiles])].sort();
  for (const rel of union) {
    const inLocal = localFiles.includes(rel);
    const inSibling = siblingFiles.includes(rel);
    if (!inLocal) {
      problems.push(`${entry.local}/${rel} is missing locally but present in the sibling`);
    } else if (!inSibling) {
      problems.push(`${entry.sibling}/${rel} is missing in the sibling but present locally`);
    } else if (
      normalizeEol(readTextFileSync(join(localAbs, rel))) !==
      normalizeEol(readTextFileSync(join(siblingAbs, rel)))
    ) {
      problems.push(`${entry.local}/${rel} differs from sibling ${entry.sibling}/${rel}`);
    }
  }
  return problems;
}
