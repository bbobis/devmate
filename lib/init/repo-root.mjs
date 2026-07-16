// @ts-check
import { basename, dirname, join, resolve } from "node:path";
import { pathExists } from "../fs-safe.mjs";
import {
  findCodeWorkspaceFile,
  matchFolderForCwd,
  parseWorkspaceFolders,
} from "./workspace-file.mjs";

/**
 * Repo markers that identify the root of a devmate-enabled repository, in
 * PRECEDENCE order — not as an unordered set. Both resolvers look for an
 * existing `.devmate/` across the whole upward walk before considering
 * `.git`/`package.json`, because in the monoroot worktree layout `.devmate/`
 * sits at the workspace root beside repo subfolders that each carry their own
 * `.git`. Treating the markers as interchangeable makes the nearest `.git` win
 * and resolves a root that holds no devmate state.
 *
 * A `.git` entry may be a dir or a file (git worktrees use a file); `pathExists`
 * covers both.
 * @type {string[]}
 */
export const REPO_MARKERS = [".devmate", ".git", "package.json"];

/**
 * If a directory has landed *inside* the workspace's own `.devmate/` folder,
 * climb out to its parent so callers resolve the workspace root, not the config
 * folder. The multi-worktree util lists `.devmate` first in the generated
 * `.code-workspace`, so it can become the process cwd; without this a caller
 * that appends `.devmate/state/…` writes to `.devmate/.devmate/state/…` (and,
 * once that exists, step 0 below would keep re-resolving there). Idempotent — a
 * directory not named `.devmate` is returned unchanged.
 * @param {string} dir  Absolute directory path.
 * @returns {string}
 */
export function climbOutOfDevmate(dir) {
  return basename(dir) === ".devmate" ? dirname(dir) : dir;
}

/**
 * Resolve the workspace root for a HOOK invocation, synchronously.
 *
 * This is the one root every hooks.json entrypoint must use for `.devmate/`
 * reads and writes. The host gives a hook exactly two anchors, both weak:
 * `payload.cwd` (documented, but OPTIONAL — it can be absent) and
 * `process.cwd()` (undocumented, and in a multi-root workspace unspecified;
 * observed to be workspaceFolders[0], which monoroot makes the workspace's own
 * `.devmate/` folder). No hook event carries a workspaceRoot/repoRoot field —
 * see the HookPayload typedef. So the root must be INFERRED, and inferring it
 * per-hook is how half the entrypoints ended up writing to
 * `.devmate/.devmate/…` while the other half wrote correctly (#76).
 *
 * Resolution: start from `payload.cwd` when present (else process.cwd()),
 * climb out of a `.devmate/` cwd, then walk up for `.devmate/` FIRST and only
 * fall back to the nearest `.git`/`package.json` when no `.devmate/` exists
 * anywhere above. Synchronous because hook entrypoints read stdin
 * synchronously and must not race their own I/O; the async `resolveRepoRoot`
 * keeps the `.code-workspace` fallback for the init path.
 *
 * `.devmate/` must outrank the other markers, not merely join them. This used
 * to be one undifferentiated "nearest marker wins" walk, on the stated
 * assumption that "by the time a hook runs, `.devmate/` exists and the marker
 * walk always terminates on it". That holds only when `.devmate/` sits at or
 * below the nearest `.git`. In the monoroot worktree layout it does not:
 * `.devmate/` is scaffolded at the WORKSPACE root, beside repo subfolders that
 * each carry their own `.git`. A hook whose cwd was inside one of those repos
 * stopped at that repo's `.git` and never climbed to the real `.devmate/` —
 * so it read and wrote a phantom `<repo>/.devmate/` while SessionStart (which
 * resolves via `resolveRepoRoot` and its step-0 sibling check) used the
 * workspace root. State was written where nothing read it.
 *
 * @param {{ cwd?: string } | undefined} [payload]  Parsed hook stdin payload.
 * @returns {string}  Absolute workspace root.
 */
export function resolveHookRoot(payload) {
  const raw =
    payload !== undefined && typeof payload.cwd === "string" && payload.cwd !== ""
      ? payload.cwd
      : process.cwd();
  const start = climbOutOfDevmate(resolve(raw));

  const anchored = anchorOnDevmate(start);
  if (anchored !== null) return anchored.root;

  // No marker anywhere above: fall back to the climbed start, mirroring
  // resolveRepoRoot's final fallback. A hook in this situation writes relative
  // to a dir devmate has never initialized — visible, at worst, as a stray
  // .devmate/.
  return start;
}

/**
 * Resolve the correct repo root for init/writes in a (possibly multi-root)
 * workspace.
 *
 * Resolution order (first match wins):
 *  0. .devmate/ is a direct child of startDir → short-circuit, use startDir
 *       (multi-root worktree layout: .devmate/ sits as a sibling of the repos)
 *  1. Walk up from startDir → nearest ancestor with .devmate/ → use that root
 *  2. Walk up from startDir → nearest ancestor with .git or package.json → use that root
 *  3. Walk up from startDir → find *.code-workspace → parseWorkspaceFolders
 *       → matchFolderForCwd(folders, startDir) → if match, use matched folder
 *  4. Fall back to startDir (resolved to absolute)
 *
 * Step 0 handles the multi-worktree workspace layout where VS Code opens the
 * worktree root and .devmate/ lives there as a direct sibling of the repo
 * subfolders. Step 1 handles the same layout when cwd is *inside* one of those
 * repo subfolders: an existing .devmate/ outranks a nearer .git, because in
 * that layout each repo carries its own .git and stopping at the nearest one
 * resolves a root that holds no devmate state (see resolveHookRoot, which must
 * agree with this order — the two resolvers disagreeing is what produced #76).
 * Step 2 covers the not-yet-initialized repo. Step 3 handles the edge case
 * where VS Code sets cwd to the workspace parent (no markers there) but a
 * .code-workspace file exists nearby listing the individual repo folders.
 * Step 4 is the final safe fallback.
 *
 * Emits a [devmate] log line to stderr on every resolution path so the calling
 * hook always knows which step matched. Step 5 (startDir fallback) is explicitly
 * labelled to make silent mis-resolution visible in the VS Code output panel.
 *
 * Performs no writes.
 *
 * @param {string} startDir  Absolute starting directory (typically payload cwd or process.cwd()).
 * @returns {Promise<string>}  Absolute path to the resolved repo root.
 */
export async function resolveRepoRoot(startDir) {
  // Normalize a cwd that landed inside the workspace's own .devmate/ folder
  // before any resolution, so step 0 and the marker walk anchor on the workspace
  // root rather than the config folder.
  const start = climbOutOfDevmate(resolve(startDir));

  // Step 0: .devmate/ is a direct child of startDir — the root is right here.
  // True in BOTH layouts: an ordinary initialized single-root repo, and the
  // multi-root worktree layout where monoroot scaffolds .devmate/ as a sibling
  // of the repo subfolders. The log line used to say "multi-root .devmate
  // sibling" unconditionally, which mislabeled every single-root repo during
  // exactly the debugging this line exists for — it made a plain repo look
  // like a multi-root workspace in the output panel (#76).
  if (pathExists(join(start, ".devmate"))) {
    const flavor = pathExists(join(start, ".git")) || pathExists(join(start, "package.json"))
      ? "single-root repo with .devmate"
      : "workspace root with .devmate sibling (multi-root layout)";
    process.stderr.write(
      `[devmate] repoRoot resolved: ${start} (step: 0 — ${flavor})\n`,
    );
    return start;
  }

  // Steps 1-2: anchor on .devmate/, else the nearest ordinary repo marker.
  // Shared with resolveHookRoot so the two resolvers cannot disagree.
  const anchored = anchorOnDevmate(start);
  if (anchored !== null) {
    process.stderr.write(
      `[devmate] repoRoot resolved: ${anchored.root} (step: 1 — ${anchored.step})\n`,
    );
    return anchored.root;
  }

  // Step 3: No marker found — try .code-workspace fallback.
  try {
    const wsFile = await findCodeWorkspaceFile(resolve(startDir));
    if (wsFile) {
      const folders = await parseWorkspaceFolders(wsFile);
      const matched = matchFolderForCwd(folders, resolve(startDir));
      if (matched) {
        process.stderr.write(
          `[devmate] repoRoot resolved: ${matched} (step: 3 — .code-workspace match)\n`,
        );
        return matched;
      }
    }
  } catch {
    // Best-effort: never throw from a fallback path.
  }

  // Step 4: Fall back to the CLIMBED start — not the raw startDir.
  //
  // ⚠️  This means no repo marker was found anywhere above startDir and no
  // .code-workspace file matched. `.devmate/` will be created inside the
  // returned directory. If that is wrong (e.g. VS Code opened a workspace
  // parent), run `devmate init` from the correct project directory.
  //
  // This branch used to return `resolve(startDir)` — the value from BEFORE
  // climbOutOfDevmate — which is the one place in the file that could still hand
  // back a `.devmate` folder as the workspace root, i.e. the #76 bug. It is not
  // reachable today for an existing directory (a `.devmate` cwd that exists on
  // disk always matches step 0, since the folder we climbed out of IS the
  // `.devmate` child step 0 looks for), so this is defence, not a live fix. But
  // the two resolvers disagreeing on their fallback is precisely the kind of
  // "correct at the top, discarded at the bottom" split that produced the
  // original defect, and one of them can only be right. `resolveHookRoot`
  // returns `start`; so does this (#77).
  process.stderr.write(
    `[devmate] repoRoot resolved: ${start} (step: 4 — startDir fallback, no marker found)\n`,
  );
  return start;
}

/**
 * Walk up from `start` and return the first ancestor (inclusive) containing any
 * of `markers`, or null if the filesystem root is reached without a hit.
 * @param {string} start  Absolute directory path.
 * @param {...string} markers  Marker names to look for at each level.
 * @returns {string | null}
 */
function findAncestorWith(start, ...markers) {
  // Bounded: a path cannot have more segments than its own length, so this is a
  // hard ceiling on the walk even if `dirname` ever failed to reach a fixpoint.
  let current = start;
  for (let depth = 0; depth <= start.length; depth++) {
    if (markers.some((marker) => pathExists(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve the workspace root by anchoring on `.devmate/`, falling back to the
 * nearest ordinary repo marker. Shared by both resolvers so they can never
 * disagree (a split between them is the #76 defect shape). Pure; performs no
 * writes and no logging.
 *
 * The `.devmate/` search is deliberately BOUNDED to three places — the start
 * dir, the nearest repo marker, and that marker's parent:
 *
 *   1. `<start>/.devmate`         — cwd is the workspace root already.
 *   2. `<markerRoot>/.devmate`    — the ordinary single-root repo (devmate's own
 *                                   layout: `.devmate/` beside `.git/`).
 *   3. `<markerRoot>/../.devmate` — the monoroot worktree layout, where
 *                                   `.devmate/` sits as a SIBLING of the repo
 *                                   subfolders and each subfolder carries its
 *                                   own `.git`. Crossing exactly one repo
 *                                   boundary is what lets a hook whose cwd is
 *                                   inside `repo-a/` find the workspace root.
 *
 * It must not be an unbounded upward search for `.devmate`. A stray `.devmate/`
 * left in a parent directory — a home dir, a projects folder — would otherwise
 * hijack root resolution for every uninitialized repo beneath it, which is the
 * same class of silent mis-resolution this function exists to prevent (and such
 * strays exist in the wild, since they are exactly what the old bug produced).
 *
 * @param {string} start  Absolute, already climbed-out-of-.devmate start dir.
 * @returns {{ root: string, step: string } | null}  null when no marker exists anywhere above.
 */
function anchorOnDevmate(start) {
  if (pathExists(join(start, ".devmate"))) {
    return { root: start, step: "startDir .devmate" };
  }

  const markerRoot = findAncestorWith(start, ".devmate", ".git", "package.json");
  if (markerRoot === null) return null;

  if (pathExists(join(markerRoot, ".devmate"))) {
    return { root: markerRoot, step: "marker walk (.devmate at repo root)" };
  }

  // Monoroot: the repo we landed in has its own .git but no .devmate. Look
  // exactly one level up — no further — for the workspace root that holds it.
  const parent = dirname(markerRoot);
  if (parent !== markerRoot && pathExists(join(parent, ".devmate"))) {
    return { root: parent, step: ".devmate sibling of repo (monoroot layout)" };
  }

  return { root: markerRoot, step: "marker walk (uninitialized)" };
}
