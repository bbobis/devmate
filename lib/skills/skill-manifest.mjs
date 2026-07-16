// @ts-check
import path from 'node:path';
import { listDirEntries, readTextFile } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').SkillManifest} SkillManifest */

/** Maximum allowed lines in a skill's trigger stub (frontmatter + common path only). */
export const TRIGGER_LINE_BUDGET = 30;

/**
 * Skill ids the plugin owns exclusively. A workspace skill that reuses one of
 * these ids is ignored (the plugin wins), because these drive the gate machine
 * and a shadowing override would silently break the workflow. Non-reserved ids
 * are freely overridable by the workspace (project-specific customization).
 * @type {readonly string[]}
 */
export const RESERVED_SKILL_IDS = Object.freeze([
  'orchestrator-feature-lane',
  'orchestrator-bug-lane',
  'orchestrator-chore-lane',
]);

/** Name of the trigger stub file inside each skill directory. */
const TRIGGER_FILE_NAME = 'SKILL.md';

/** Name of the sibling directory holding lazy reference files. */
const REFS_DIR_NAME = 'refs';

/**
 * Join a child name under a base directory and reject traversal.
 * @param {string} baseDir
 * @param {string} childName
 * @returns {string|null}
 */
function safeJoinWithin(baseDir, childName) {
  const candidate = path.resolve(baseDir, childName);
  const base = path.resolve(baseDir);
  if (candidate === base || candidate.startsWith(`${base}${path.sep}`)) {
    return candidate;
  }
  return null;
}

/**
 * Recursively find every SKILL.md under `dir`, returning absolute paths.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findTriggerFiles(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = safeJoinWithin(dir, entry.name);
    if (full === null) continue;
    if (entry.isDirectory()) {
      found.push(...(await findTriggerFiles(full)));
    } else if (entry.isFile() && entry.name === TRIGGER_FILE_NAME) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Parse a YAML-ish frontmatter scalar/array value.
 * Supports `key: value`, `key: ['a', 'b']`, and bare strings.
 * @param {string} raw
 * @returns {string|string[]}
 */
function parseValue(raw) {
  const trimmed = raw.trim();
  const unquote = (/** @type {string} */ value) => {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
    return value;
  };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }
  return unquote(trimmed);
}

/**
 * Minimal frontmatter parser. Reads the block delimited by the first two `---`
 * lines and returns flat key -> value pairs. No third-party YAML library.
 *
 * Supports two array styles:
 *   - inline:    `triggers: ['a', 'b']`
 *   - multiline: `triggers:` followed by `  - a` / `  - b` block-list lines
 * @param {string} content
 * @returns {Record<string, string|string[]>}
 */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  /** @type {Map<string, string|string[]>} */
  const out = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) continue;

    // Multiline block list: `key:` with no inline value, followed by `- item` lines.
    if (value.trim() === '') {
      /** @type {string[]} */
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === '---') break;
        const trimmed = next.trimStart();
        if (!trimmed.startsWith('- ')) break;
        const raw = trimmed.slice(2).trim();
        const first = raw[0];
        const last = raw[raw.length - 1];
        const item =
          (first === '"' && last === '"') || (first === "'" && last === "'")
            ? raw.slice(1, -1)
            : raw;
        if (item.length > 0) items.push(item);
      }
      if (items.length > 0) {
        out.set(key, items);
        i = j - 1;
        continue;
      }
    }

    out.set(key, parseValue(value));
  }
  return Object.fromEntries(out);
}

/**
 * Coerce a frontmatter field into a string array.
 * Accepts an array, a single string, or undefined.
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function toStringArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/**
 * Coerce a frontmatter field into a number.
 * Returns the defaultValue when the field is absent, empty, or non-numeric.
 * @param {string|string[]|undefined} value
 * @param {number} defaultValue
 * @returns {number}
 */
function toNumber(value, defaultValue) {
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (!Number.isNaN(n)) return n;
  }
  return defaultValue;
}

/**
 * List `.md` reference files in a skill's sibling `refs/` directory.
 * @param {string} skillDir  Directory containing the SKILL.md.
 * @returns {Promise<string[]>}
 */
async function discoverRefFiles(skillDir) {
  const refsDir = path.join(skillDir, REFS_DIR_NAME);
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await listDirEntries(refsDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => safeJoinWithin(refsDir, e.name))
    .filter((abs) => abs !== null)
    .map((abs) => path.relative(skillDir, /** @type {string} */ (abs)))
    .sort();
}

/**
 * Load all skill manifests from a skills directory.
 * Reads each SKILL.md frontmatter, counts lines, and discovers ref files.
 * @param {string} skillsDir  Absolute path to skills root directory.
 * @returns {Promise<SkillManifest[]>}
 */
export async function loadSkillManifests(skillsDir) {
  const triggerFiles = await findTriggerFiles(skillsDir);
  /** @type {SkillManifest[]} */
  const manifests = [];
  // @bounded-alloc — one manifest object per skill trigger file discovered in
  // the repo-local skills directory; count is the number of installed skills.
  for (const triggerFile of triggerFiles) {
    const content = await readTextFile(triggerFile);
    const fm = parseFrontmatter(content);
    const skillDir = path.dirname(triggerFile);
    const skillId = typeof fm.name === 'string' && fm.name ? fm.name : path.basename(skillDir);
    const refFiles = await discoverRefFiles(skillDir);
    manifests.push({
      skillId,
      description: typeof fm.description === 'string' ? fm.description : '',
      triggerFile: path.relative(skillsDir, triggerFile),
      refFiles,
      triggers: toStringArray(fm.triggers),
      tags: toStringArray(fm.tags),
      negativeTriggers: toStringArray(fm.negative_triggers),
      synonyms: toStringArray(fm.synonyms),
      priority: toNumber(/** @type {string|undefined} */ (Array.isArray(fm.priority) ? undefined : fm.priority), 5),
      triggerLineCount: content.split('\n').length,
    });
  }
  manifests.sort((a, b) => a.skillId.localeCompare(b.skillId));
  return manifests;
}

/**
 * @typedef {Object} SkillRoot
 * @property {string} dir     Absolute path to a skills root directory.
 * @property {string} source  Provenance label, e.g. 'plugin' or 'workspace'.
 */

/**
 * @typedef {Object} MergedSkillManifests
 * @property {SkillManifest[]} manifests  The merged, deduped, sorted manifests.
 * @property {Array<{ source: string, dir: string, count: number }>} sources  Per-root load counts (the loader canary).
 */

/**
 * Load skill manifests from multiple roots and merge them into one catalog.
 *
 * Roots are processed in order, so a later root (e.g. the workspace) overrides
 * an earlier one (e.g. the plugin) on a skillId collision — EXCEPT for
 * {@link RESERVED_SKILL_IDS}, which only the first `source: 'plugin'` root may
 * define. Each root is fault-isolated: a missing or unreadable directory yields
 * zero skills, never an error, so one bad root can never blank the catalog. Each
 * returned manifest is tagged with its `source`, and per-root counts are
 * reported so the caller can tell an empty plugin catalog (the loader bug) from
 * a workspace that simply ships no skills.
 *
 * @param {SkillRoot[]} roots  Ordered; later roots win on collision.
 * @returns {Promise<MergedSkillManifests>}
 */
export async function loadMergedSkillManifests(roots) {
  /** @type {Map<string, SkillManifest>} */
  const byId = new Map();
  /** @type {Array<{ source: string, dir: string, count: number }>} */
  const sources = [];

  for (const { dir, source } of roots) {
    /** @type {SkillManifest[]} */
    let loaded = [];
    try {
      loaded = await loadSkillManifests(dir);
    } catch {
      loaded = []; // fault-isolated per root — a bad root never blanks the catalog.
    }
    sources.push({ source, dir, count: loaded.length });

    for (const m of loaded) {
      if (source !== 'plugin' && RESERVED_SKILL_IDS.includes(m.skillId)) {
        process.stderr.write(
          `skill-manifest: ${source} skill '${m.skillId}' ignored — reserved by the plugin.\n`,
        );
        continue;
      }
      byId.set(m.skillId, { ...m, source });
    }
  }

  const manifests = [...byId.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
  return { manifests, sources };
}

/**
 * Validate that all skill trigger stubs are within TRIGGER_LINE_BUDGET.
 * @param {SkillManifest[]} manifests
 * @returns {{ ok: boolean, violations: Array<{ skillId: string, lineCount: number, budget: number }> }}
 */
export function validateSkillSplit(manifests) {
  /** @type {Array<{ skillId: string, lineCount: number, budget: number }>} */
  const violations = [];
  for (const m of manifests) {
    if (m.triggerLineCount > TRIGGER_LINE_BUDGET) {
      violations.push({
        skillId: m.skillId,
        lineCount: m.triggerLineCount,
        budget: TRIGGER_LINE_BUDGET,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
