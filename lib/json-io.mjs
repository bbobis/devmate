// @ts-check
// Audited JSON I/O helpers.
//
// Every JSON value this tool deserializes is a repo-local state artifact that
// the tool itself (or the test that is asserting on it) wrote: gates.json,
// task.json, *-result.json, JSONL ledgers and traces. Nothing here parses
// network responses or foreign user input. Centralizing the JSON.parse calls
// keeps that trust boundary in one reviewable module — callers must still
// treat the parsed value as `unknown` and validate its shape.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  appendTextFile,
  ensureDir,
  ensureDirSync,
  renamePath,
  renamePathSync,
  writeTextFile,
  writeTextFileSync,
} from './fs-safe.mjs';

/**
 * Parse JSON, throwing on malformed input (plain JSON.parse semantics).
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  // @trusted-local-json — repo-local artifact/CLI output authored by this tool.
  return JSON.parse(text);
}

/**
 * Parse JSON; null when malformed instead of throwing.
 * @param {string} text
 * @returns {unknown|null}
 */
export function parseJsonSafe(text) {
  try {
    // @trusted-local-json — repo-local artifact/CLI output authored by this tool.
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse JSONL text: one JSON value per non-blank line. Throws on a malformed
 * line (callers that need lenience filter beforehand or catch).
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseJsonl(text) {
  /** @type {unknown[]} */
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    // @trusted-local-json — repo-local JSONL ledger/trace authored by this tool.
    rows.push(JSON.parse(line));
  }
  return rows;
}

/**
 * Read + parse a local JSON artifact; null when absent or unparseable.
 * @param {string} filePath
 * @returns {Promise<unknown|null>}
 */
export async function readJsonFile(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited I/O choke point (see module header): callers pass join(repoRoot|tmpdir, CONSTANT[, validated segment]) paths; the rule has no options or taint analysis, so the single disable lives here instead of at every call site.
    return parseJson(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Sync variant of {@link readJsonFile}.
 * @param {string} filePath
 * @returns {unknown|null}
 */
export function readJsonFileSync(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited I/O choke point (see module header): callers pass join(repoRoot|tmpdir, CONSTANT[, validated segment]) paths; the rule has no options or taint analysis, so the single disable lives here instead of at every call site.
    return parseJson(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a JSONL file and parse every non-blank line (throws on malformed lines
 * or a missing file).
 * @param {string} filePath
 * @returns {Promise<unknown[]>}
 */
export async function readJsonl(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited I/O choke point (see module header).
  return parseJsonl(await readFile(filePath, 'utf8'));
}

/**
 * Sync variant of {@link readJsonl}.
 * @param {string} filePath
 * @returns {unknown[]}
 */
export function readJsonlSync(filePath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- audited I/O choke point (see module header).
  return parseJsonl(readFileSync(filePath, 'utf8'));
}

/**
 * Serialize `value` (2-space indent, trailing newline) and write it atomically:
 * write to `<path>.tmp`, then rename over the target. Creates parent dirs.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonFileAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  await ensureDir(dirname(filePath));
  await writeTextFile(tmpPath, JSON.stringify(value, null, 2) + '\n');
  await renamePath(tmpPath, filePath);
}

/**
 * Sync variant of {@link writeJsonFileAtomic}.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
export function writeJsonFileAtomicSync(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  ensureDirSync(dirname(filePath));
  writeTextFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
  renamePathSync(tmpPath, filePath);
}

/**
 * Append one JSON value as a single JSONL line.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function appendJsonlLine(filePath, value) {
  await appendTextFile(filePath, JSON.stringify(value) + '\n');
}
