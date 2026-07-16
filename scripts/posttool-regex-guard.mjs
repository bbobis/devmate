// @ts-check
import { isAbsolute, resolve } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { pathExists, readTextFileSync } from "../lib/fs-safe.mjs";
import { KNOWN_SOURCE_EDIT_TOOLS } from "../lib/gate-guard-core.mjs";
import { EXIT_BLOCK } from "../lib/hooks/output-schema.mjs";
import { toolInputPaths } from "../lib/hooks/tool-input.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { parseJsonSafe } from "../lib/json-io.mjs";

/**
 * Read all stdin into a string.
 * @returns {Promise<string>}
 */
async function readAllStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  // @bounded-alloc — one Buffer per stdin chunk; bounded by the piped hook payload.
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse JSON safely.
 * @param {string} raw
 * @returns {unknown|null}
 */
function parseJson(raw) {
  return parseJsonSafe(raw);
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
function asObject(payload) {
  if (payload === null || typeof payload !== "object") return {};
  return /** @type {Record<string, unknown>} */ (payload);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function readObject(obj, key) {
  const value = new Map(Object.entries(obj)).get(key);
  if (value === null || typeof value !== "object") return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Collect candidate file paths from the tool input.
 *
 * This used to scan `tool_input` *and* a camelCase `toolInput` (the Copilot CLI
 * shape — a surface devmate does not target), read a `path` key VS Code never
 * sends, and miss `replacements[]` and `apply_patch` bodies entirely. It now
 * defers to the one parser that owns the question.
 * @param {Record<string, unknown>} payload
 * @returns {string[]}
 */
function collectFilePaths(payload) {
  return toolInputPaths(readObject(payload, "tool_input"));
}

/**
 * Detect dynamic RegExp construction in file content.
 * @param {string} content
 * @returns {string[]}
 */
function findDynamicRegExpViolations(content) {
  const lines = content.split("\n");
  /** @type {string[]} */
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf("new RegExp(");
    if (idx === -1) continue;

    const after = line.slice(idx + "new RegExp(".length).trimStart();
    const first = after[0] ?? "";
    if (first === "\"" || first === "'") continue;
    if (first === "`") {
      if (!after.includes("${")) continue;
    }
    violations.push(`line ${i + 1}`);
  }

  return violations;
}

/**
 * PostToolUse guard: block an edit that introduces a dynamic `RegExp`.
 *
 * Its edit-tool list was `write_file`, `replace_in_file`,
 * `insert_content_into_file`, `str_replace_editor` — four names VS Code has
 * never sent — plus `apply_patch`. So of every write VS Code can make, this
 * security guard inspected exactly one, and `create_file` /
 * `replace_string_in_file` / `insert_edit_into_file` sailed straight past it.
 * The vocabulary now comes from the gate guard's list, which is the repo's one
 * answer to "what writes source".
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  const raw = await readAllStdin();
  const parsed = parseJson(raw);
  const payload = asObject(parsed);

  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "";

  if (!KNOWN_SOURCE_EDIT_TOOLS.includes(toolName)) return 0;

  // A relative path must be anchored on the WORKSPACE ROOT, never on the hook's
  // cwd. `resolve(p)` alone anchors on process.cwd(), which for a hook is the
  // workspace's own `.devmate/` folder in the monoroot layout — so a relative
  // edit path became `<workspace>/.devmate/lib/foo.mjs`, which does not exist,
  // and the `pathExists` check below then SKIPPED it. A security guard that
  // quietly declines to look at a file it cannot find is bypassable by the shape
  // of a path, and VS Code's own hooks-reference example for `edit_files` shows
  // relative entries (`files: ["src/safe.ts"]`).
  const root = resolveHookRoot(/** @type {{ cwd?: string }} */ (payload));
  const candidates = collectFilePaths(payload)
    .map((p) => (isAbsolute(p) ? p : resolve(root, p)))
    .filter((p) => p.toLowerCase().endsWith(".mjs"));

  /** @type {string[]} */
  const problems = [];
  for (const filePath of candidates) {
    if (!pathExists(filePath)) continue;
    const content = readTextFileSync(filePath);
    const findings = findDynamicRegExpViolations(content);
    if (findings.length > 0) {
      problems.push(`${filePath} (${findings.join(", ")})`);
    }
  }

  // Nothing to say: stdout stays empty. `{"decision":"continue"}` was not a
  // thing — the host's vocabulary for `decision` is "block", and nothing else.
  if (problems.length === 0) return 0;

  // Exit 2 is the documented blocking error, and its stderr is the stream the
  // model is shown. The old code put the message on stdout and then exited 2 —
  // and on a non-zero exit the host never parses stdout, so the explanation of
  // *why* the edit was blocked went nowhere.
  process.stderr.write(
    "Blocked: dynamic RegExp construction detected. Refactor to deterministic parsing or static pattern checks.\n" +
      problems.join("\n") +
      "\n",
  );
  return EXIT_BLOCK;
}

// Only run when executed directly, not when imported by tests (CONTRIBUTING §6).
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
