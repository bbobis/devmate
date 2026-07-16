// @ts-check
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir, pathExists } from '../fs-safe.mjs';

/**
 * Repo-relative path of the Copilot prompt file that exposes the `/devmate`
 * slash command. Built with join so it is correct on Windows too.
 * @type {string}
 */
export const DEVMATE_PROMPT_RELPATH = join('.github', 'prompts', 'devmate.prompt.md');

/**
 * Canonical content of the `/devmate` prompt file — the single source of truth.
 * The committed `.github/prompts/devmate.prompt.md` is asserted equal to this in
 * test, and this is exactly what init scaffolds into a consumer repo. Its
 * `agent` frontmatter field pins the run to the orchestrator custom agent, so a
 * user can type `/devmate <task>` without first selecting the orchestrator from
 * the mode dropdown.
 * @type {string}
 */
export const DEVMATE_PROMPT_CONTENT = [
  '---',
  'description: Run the devmate stage-gated orchestrator on your task — no need to pick the agent from the mode dropdown first.',
  'agent: orchestrator',
  '---',
  '',
  'Start the **devmate orchestrator** for the task I describe after `/devmate`.',
  '',
  'You are the orchestrator: the single entry point for the stage-gated workflow.',
  'Follow your standard entry protocol — classify the lane with `@router` (Step 0),',
  'then drive the feature / bug / chore lane and own the gate state. Never edit',
  'source directly; delegate implementation to `@fullstack` per your dispatch',
  'protocol.',
  '',
  'Treat everything I type after `/devmate` as the task. If I did not include a',
  'task, ask me for one before doing anything else.',
  '',
].join('\n');

/**
 * @typedef {Object} ScaffoldPromptResult
 * @property {string|null} created  Absolute path written, or null when skipped.
 * @property {boolean} skipped      True when the file already existed (never overwritten).
 */

/**
 * Idempotently scaffold the `/devmate` prompt file under `repoRoot`. Create-only:
 * an existing file is never overwritten (a consumer may have customised it), so
 * this is safe to call on every init. Returns a result object rather than
 * throwing on the expected "already there" case, so the caller can report the
 * outcome without failing the whole init.
 *
 * @param {string} repoRoot  Absolute path to the workspace/repo root.
 * @returns {Promise<ScaffoldPromptResult>}
 */
export async function ensureDevmatePromptFile(repoRoot) {
  const abs = join(repoRoot, DEVMATE_PROMPT_RELPATH);
  if (pathExists(abs)) {
    return { created: null, skipped: true };
  }
  await ensureDir(dirname(abs));
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 'wx' (O_EXCL) create-only write IS the never-overwrite guarantee for the scaffolded prompt file; the fs-safe facade writers deliberately do not expose open flags. Path is join(repoRoot, DEVMATE_PROMPT_RELPATH).
    await writeFile(abs, DEVMATE_PROMPT_CONTENT, { flag: 'wx' });
  } catch (err) {
    // Lost a create race (file appeared between the check and the exclusive
    // create): treat as an already-present skip, never an error.
    if ((/** @type {NodeJS.ErrnoException} */ (err)).code === 'EEXIST') {
      return { created: null, skipped: true };
    }
    throw err;
  }
  return { created: abs, skipped: false };
}
