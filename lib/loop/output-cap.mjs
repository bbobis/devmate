// @ts-check
// =============================================================================
// The output cap is the token boundary.
// Do not return output_full by default. Agents that receive full command output
// will silently exhaust their context window.
// =============================================================================

/**
 * @typedef {import('../types.mjs').LoopOutput} LoopOutput
 * @typedef {import('../types.mjs').LoopOutputFull} LoopOutputFull
 * @typedef {import('./run-command.mjs').RunCommandResult} RunCommandResult
 */

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ensureDirSync, writeTextFileSync } from '../fs-safe.mjs';

/** Default output cap in characters (4 KiB). */
const DEFAULT_MAX_BYTES = 4096;

/** Truncation notice appended when output is cut short. */
const TRUNCATION_NOTICE = '\n[...output truncated — see full_output_path for complete log]';

/**
 * Secret pattern factories — called fresh each time to avoid stateful lastIndex.
 * Each factory returns a new RegExp instance.
 * Best-effort; not a security guarantee.
 * @returns {RegExp[]}
 */
function secretPatterns() {
  return [
    // env-var style: KEY=value — name contains a secret-like word, capture value.
    // Leading [A-Z0-9_]* may be empty so a bare `SECRET=...` still matches (the previous
    // [A-Z_][A-Z0-9_]* prefix was greedy and consumed the secret word, so `SECRET=x` never matched).
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|PWD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gi,
    // Bearer token
    /(Bearer\s+)([A-Za-z0-9\-_+/=]{20,})/g,
    // Authorization header value
    /(Authorization:\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9\-_+/=]{20,})/gi,
    // Generic base64-like string >40 chars immediately following = or :
    /([=:]\s*)([A-Za-z0-9+/]{40,}={0,2})/g,
  ];
}

/**
 * Cap raw text to `maxBytes` characters.
 * Appends a truncation notice when text is longer.
 * @param {string} raw
 * @param {{ maxBytes?: number }} [opts]  Default maxBytes: 4096.
 * @returns {string}
 */
export function capOutput(raw, opts) {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (raw.length <= maxBytes) return raw;
  return raw.slice(0, maxBytes) + TRUNCATION_NOTICE;
}

/**
 * Redact likely secrets from text.
 * Replaces matched secret values with [REDACTED].
 * Best-effort — not a security guarantee.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let result = text;
  // Fresh patterns each call — avoids lastIndex statefulness on global regexes.
  // group 1 = prefix to keep (KEY, `Bearer `, `Authorization: ...`, or `=`/`:` lead-in).
  // For the env-var form (KEY=value) re-insert the `=` so it reads `KEY=[REDACTED]`.
  for (const pattern of secretPatterns()) {
    result = result.replace(pattern, (match, prefix) => {
      const sep = match.charAt(prefix.length) === '=' ? '=' : '';
      return `${prefix}${sep}[REDACTED]`;
    });
  }
  return result;
}

/**
 * Compute SHA-256 digest (first 64 hex chars) of a string.
 * @param {string} text
 * @returns {string}
 */
function sha256hex64(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

/**
 * Build a LoopOutput from a RunCommandResult.
 * Writes full combined output to an artifact file.
 * Does NOT include output_full unless includeFullOutput is true.
 *
 * @overload
 * @param {RunCommandResult} runResult
 * @param {{ attemptId: string, outputDir: string, includeFullOutput?: false, maxCapBytes?: number }} opts
 * @returns {Promise<LoopOutput>}
 */
/**
 * @overload
 * @param {RunCommandResult} runResult
 * @param {{ attemptId: string, outputDir: string, includeFullOutput: true, maxCapBytes?: number }} opts
 * @returns {Promise<LoopOutputFull>}
 */
/**
 * Build a LoopOutput from a RunCommandResult.
 * Writes full output to artifact file.
 * Does NOT include output_full unless includeFullOutput is true.
 * @param {RunCommandResult} runResult
 * @param {{
 *   attemptId: string,
 *   outputDir: string,
 *   passed?: boolean,
 *   includeFullOutput?: boolean,
 *   maxCapBytes?: number,
 * }} opts
 * @returns {Promise<LoopOutput | LoopOutputFull>}
 */
export async function buildLoopOutput(runResult, opts) {
  const { attemptId, outputDir, includeFullOutput = false, maxCapBytes } = opts;
  const passed = opts.passed ?? (runResult.exitCode === 0 && !runResult.timedOut);

  // Combine stdout + stderr (stdout first, stderr after separator).
  const combined =
    runResult.stdout +
    (runResult.stderr.length > 0 ? '\n--- stderr ---\n' + runResult.stderr : '');

  const output_digest = sha256hex64(combined);

  // Write artifact file.
  const absDir = resolve(outputDir);
  ensureDirSync(absDir);
  const full_output_path = join(absDir, `${attemptId}.txt`);
  writeTextFileSync(full_output_path, combined);

  const redacted = redactSecrets(combined);
  const output_capped = capOutput(redacted, { maxBytes: maxCapBytes });

  /** @type {LoopOutput} */
  const base = {
    passed,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut,
    output_capped,
    output_digest,
    full_output_path,
    durationMs: runResult.durationMs,
    attemptId,
  };

  if (includeFullOutput) {
    /** @type {LoopOutputFull} */
    return { ...base, output_full: redacted };
  }

  return base;
}
