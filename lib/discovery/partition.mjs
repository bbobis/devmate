// @ts-check

/**
 * FO-5: deterministic candidate partitioning for the two-phase discovery
 * fan-out. `partitionCandidates(candidates, k)` splits the Phase-1 scan's
 * candidate list into at most `k` DISJOINT partitions, one per scoped
 * `@discovery` worker. Disjointness is the hard invariant: no path appears
 * in two partitions and the union of all partitions equals the input —
 * disjoint partitions make worker overlap structurally rare (so FO-4's
 * dedup stays cheap) and no two workers comprehend the same file.
 *
 * Pure and deterministic: no I/O, no randomness, no timestamps; the same
 * input always yields the same partitions and the input array is never
 * mutated.
 */

/**
 * Oversize factor: a directory group is only ever split when its size
 * exceeds `ceil(total / k) * OVERSIZE_FACTOR`.
 * @type {number}
 */
const OVERSIZE_FACTOR = 1.5;

/**
 * Normalize a candidate path's separators for grouping (`\` -> `/`).
 * String split/join only — no regex on path text.
 * @param {string} rawPath
 * @returns {string}
 */
function toSlash(rawPath) {
  return rawPath.split('\\').join('/');
}

/**
 * The grouping key at a given directory depth: the first `depth + 1` path
 * segments joined, or `'.'` for a repo-root file with no directory at that
 * depth. Files that share the key share an ancestor directory at that depth.
 * @param {string} normalizedPath
 * @param {number} depth
 * @returns {string}
 */
function directoryKeyAtDepth(normalizedPath, depth) {
  const segments = normalizedPath.split('/').filter((s) => s !== '');
  // The last segment is the filename; only directory segments group.
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length <= depth) return dirSegments.join('/') || '.';
  return dirSegments.slice(0, depth + 1).join('/');
}

/**
 * Group candidates by their directory key at `depth`, preserving input
 * order inside each group. Iteration order of the returned map follows
 * first appearance in the input (Map insertion order) — deterministic.
 * @template {{ path: string }} T
 * @param {T[]} candidates
 * @param {number} depth
 * @returns {Map<string, T[]>}
 */
function groupByDirectory(candidates, depth) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const candidate of candidates) {
    const key = directoryKeyAtDepth(toSlash(candidate.path), depth);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  return groups;
}

/**
 * Split one oversized group into pieces no larger than `maxGroupSize`,
 * deterministically: first try the next directory depth (subtrees stay
 * together); when no deeper level distinguishes the members (all files sit
 * directly in one directory), fall back to fixed-size chunks in input order.
 * @template {{ path: string }} T
 * @param {T[]} group
 * @param {number} depth
 * @param {number} maxGroupSize
 * @returns {T[][]}
 */
function splitOversizedGroup(group, depth, maxGroupSize) {
  const subGroups = groupByDirectory(group, depth + 1);
  if (subGroups.size > 1) {
    /** @type {T[][]} */
    const out = [];
    for (const sub of subGroups.values()) {
      if (sub.length > maxGroupSize) {
        out.push(...splitOversizedGroup(sub, depth + 1, maxGroupSize));
      } else {
        out.push(sub);
      }
    }
    return out;
  }
  // No deeper directory level distinguishes the members — chunk in order.
  const stride = Math.max(1, Math.floor(maxGroupSize));
  /** @type {T[][]} */
  const chunks = [];
  for (let i = 0; i < group.length; i += stride) {
    chunks.push(group.slice(i, i + stride));
  }
  return chunks;
}

/**
 * Partition scan candidates onto at most `k` disjoint partitions for the
 * Phase-2 scoped `@discovery` workers (FO-5).
 *
 * Algorithm (all steps deterministic):
 * 1. Group by top-level directory affinity — candidates sharing their
 *    deepest common ancestor directory stay together (grouping key: the
 *    first directory segment; repo-root files form one `'.'` group).
 * 2. A group is split only when it exceeds `ceil(total / k) * 1.5`
 *    candidates — first by the next directory level (subtrees stay
 *    together), then, when a single directory is itself oversized, by
 *    fixed-size chunks in input order.
 * 3. Whole groups round-robin onto the `k` partitions balancing by
 *    candidate count: groups are ordered by size (desc, tie: key asc,
 *    then first-seen order) and each is assigned to the currently
 *    smallest partition (tie: lowest index).
 *
 * Invariants: no path appears in two partitions; the union of the returned
 * partitions is exactly the input (same objects, no copies). Empty
 * partitions are dropped, so the result length is `min(k, groups)`.
 *
 * @template {{ path: string }} T
 * @param {T[]} candidates  Scan candidates (each carries a `path`).
 * @param {number} k        Maximum number of partitions (workers), >= 1.
 * @returns {T[][]}         1..k disjoint, non-empty partitions ([] for no input).
 * @throws When `candidates` is not an array or `k` is not an integer >= 1
 *         (programmer/config error — mirrors `fanout`'s config-error stance).
 */
export function partitionCandidates(candidates, k) {
  if (!Array.isArray(candidates)) {
    throw new Error('partitionCandidates requires candidates to be an array');
  }
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
    throw new Error('partitionCandidates requires k to be an integer >= 1');
  }
  if (candidates.length === 0) return [];

  const maxGroupSize = Math.ceil(candidates.length / k) * OVERSIZE_FACTOR;

  /** @type {Array<{ dirKey: string, members: typeof candidates, order: number }>} */
  const groups = [];
  let order = 0;
  for (const [dirKey, members] of groupByDirectory(candidates, 0)) {
    if (members.length > maxGroupSize) {
      for (const piece of splitOversizedGroup(members, 0, maxGroupSize)) {
        groups.push({ dirKey, members: piece, order });
        order += 1;
      }
    } else {
      groups.push({ dirKey, members, order });
      order += 1;
    }
  }

  groups.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    // Plain code-unit comparison — locale-independent, so ordering is
    // identical on every platform (determinism guarantee).
    if (a.dirKey < b.dirKey) return -1;
    if (a.dirKey > b.dirKey) return 1;
    return a.order - b.order;
  });

  /** @type {Array<typeof candidates>} */
  const partitions = Array.from({ length: k }, () => []);
  for (const group of groups) {
    let target = 0;
    for (let i = 1; i < partitions.length; i += 1) {
      // eslint-disable-next-line secure-coding/detect-object-injection -- numeric array index over a locally-built array; no prototype-pollution surface.
      if (partitions[i].length < partitions[target].length) target = i;
    }
    // eslint-disable-next-line secure-coding/detect-object-injection -- numeric array index over a locally-built array; no prototype-pollution surface.
    partitions[target].push(...group.members);
  }

  return partitions.filter((p) => p.length > 0);
}
