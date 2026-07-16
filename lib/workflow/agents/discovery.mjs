// @ts-check

/**
 * @typedef {{ fact: string, path: string, confidence: 'high' | 'low' }} DiscoveryClaim
 */

/**
 * @typedef {{ claims: DiscoveryClaim[], unverified: string[] }} DiscoveryArtifact
 */

/**
 * Normalize one unverified item and ensure `[UNVERIFIED]` tagging.
 * @param {string} item
 * @returns {string}
 */
function normalizeUnverifiedItem(item) {
  const trimmed = item.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[UNVERIFIED]')) return trimmed;
  return `[UNVERIFIED] ${trimmed}`;
}

/**
 * Parse one discovered claim line into structured fields.
 * Accepted format: `fact | path | confidence` where confidence is optional.
 * @param {string} rawClaim
 * @returns {{ ok: true, claim: DiscoveryClaim } | { ok: false, unverified: string }}
 */
function parseDiscoveredClaim(rawClaim) {
  const trimmed = rawClaim.trim();
  if (trimmed === '') {
    return { ok: false, unverified: '[UNVERIFIED] empty claim item' };
  }

  const parts = trimmed.split('|').map((part) => part.trim());
  if (parts.length < 2) {
    return {
      ok: false,
      unverified: normalizeUnverifiedItem(`${trimmed} (missing evidence path)`),
    };
  }

  const fact = parts[0] ?? '';
  const path = parts[1] ?? '';
  const confidenceWord = (parts[2] ?? 'high').toLowerCase();
  const confidence = confidenceWord === 'low' ? 'low' : 'high';

  if (fact === '' || path === '') {
    return {
      ok: false,
      unverified: normalizeUnverifiedItem(`${trimmed} (incomplete claim fields)`),
    };
  }

  return { ok: true, claim: { fact, path, confidence } };
}

/**
 * Creates a discovery artifact with evidence pointers and confidence markers.
 * @param {string[]} discoveredClaims - List of discovered facts with file path references.
 * @param {string[]} unverifiedItems - Claims that could not be verified from code or docs.
 * @returns {{ claims: Array<{ fact: string, path: string, confidence: 'high' | 'low' }>, unverified: string[] }}
 */
export function createDiscoveryArtifact(discoveredClaims, unverifiedItems) {
  /** @type {DiscoveryClaim[]} */
  const claims = [];
  /** @type {string[]} */
  const unverified = [];

  for (const rawClaim of discoveredClaims) {
    const parsed = parseDiscoveredClaim(rawClaim);
    if (parsed.ok) {
      claims.push(parsed.claim);
      continue;
    }
    if (parsed.unverified !== '') {
      unverified.push(parsed.unverified);
    }
  }

  for (const item of unverifiedItems) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized !== '') {
      unverified.push(normalized);
    }
  }

  return { claims, unverified };
}

/**
 * Validate discovery artifact structural integrity.
 * @param {unknown} artifact - Artifact candidate to validate.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDiscoveryArtifact(artifact) {
  /** @type {string[]} */
  const errors = [];

  if (artifact === null || typeof artifact !== 'object') {
    return { ok: false, errors: ['artifact must be an object'] };
  }

  const record = /** @type {Record<string, unknown>} */ (artifact);
  const claims = record.claims;
  const unverified = record.unverified;

  if (!Array.isArray(claims)) {
    errors.push('claims must be an array');
  }

  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  }

  if (Array.isArray(claims)) {
    for (let i = 0; i < claims.length; i += 1) {
      const claim = claims[i];
      if (claim === null || typeof claim !== 'object') {
        errors.push(`claims[${i}] must be an object`);
        continue;
      }

      const claimRecord = /** @type {Record<string, unknown>} */ (claim);
      const fact = claimRecord.fact;
      const path = claimRecord.path;
      const confidence = claimRecord.confidence;

      if (typeof fact !== 'string' || fact.trim() === '') {
        errors.push(`claims[${i}].fact must be a non-empty string`);
      }

      if (typeof path !== 'string' || path.trim() === '') {
        errors.push(`claims[${i}].path must be a non-empty string`);
      }

      if (confidence !== 'high' && confidence !== 'low') {
        errors.push(`claims[${i}].confidence must be 'high' or 'low'`);
      }

      if (confidence === 'high' && (typeof path !== 'string' || path.trim() === '')) {
        errors.push(`claims[${i}] high confidence requires evidence path`);
      }
    }
  }

  if (Array.isArray(unverified)) {
    for (let i = 0; i < unverified.length; i += 1) {
      const item = unverified[i];
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`unverified[${i}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`unverified[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * FO-4: mergeDiscoveryArtifacts — the fan-in.                        *
 * ------------------------------------------------------------------ */

/** @typedef {import('../../types.mjs').MergedDiscoveryClaim} MergedDiscoveryClaim */
/** @typedef {import('../../types.mjs').MergedDiscoveryArtifact} MergedDiscoveryArtifact */
/** @typedef {import('../../types.mjs').MergeDiscoveryArtifactsOpts} MergeDiscoveryArtifactsOpts */
/** @typedef {import('../../types.mjs').MergeDiscoveryStats} MergeDiscoveryStats */
/** @typedef {import('../../types.mjs').MergeDiscoveryArtifactsResult} MergeDiscoveryArtifactsResult */

const DEFAULT_NEAR_DUP_THRESHOLD = 0.8;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
// The literal issue text reads `[UNVERIFIED — dropped by merge cap]`, but the
// untouched `validateDiscoveryArtifact` requires an exact `[UNVERIFIED]`
// prefix (case-sensitive, no interior text) — so the tag stays intact and the
// drop reason follows it, satisfying both the loud-cap intent and the
// existing validator invariant the issue explicitly calls out as preserved.
const DROPPED_BY_CAP_PREFIX = '[UNVERIFIED] — dropped by merge cap:';

/**
 * Normalize a path's directory separators without regex (security hardening:
 * deterministic string parsing over regex for path text).
 * @param {string} rawPath
 * @returns {string}
 */
function toSlash(rawPath) {
  return rawPath.split('\\').join('/');
}

/**
 * Parse a decimal line number token with explicit char-code checks — no regex.
 * @param {string} text
 * @returns {number|null}
 */
function parseLineNumber(text) {
  if (text === '') return null;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return null; // not an ASCII digit
  }
  return Number(text);
}

/**
 * Parse the anchor portion after `#L` — `162` or `162-170` or `162-L170`.
 * @param {string} text
 * @returns {{ start: number, end: number }|null}
 */
function parseAnchorRange(text) {
  const dashIndex = text.indexOf('-');
  if (dashIndex === -1) {
    const line = parseLineNumber(text);
    return line === null ? null : { start: line, end: line };
  }
  const startText = text.slice(0, dashIndex);
  const endTextRaw = text.slice(dashIndex + 1);
  const endText = endTextRaw.startsWith('L') ? endTextRaw.slice(1) : endTextRaw;
  const start = parseLineNumber(startText);
  const end = parseLineNumber(endText);
  return start === null || end === null ? null : { start, end };
}

/**
 * Split an evidence pointer into its file path and optional line anchor
 * (`agents/discovery.agent.md` — "repository-relative paths, with optional
 * line anchors"). Falls back to treating the whole string as the file path
 * when no valid `#L...` anchor is present.
 * @param {string} rawPath
 * @returns {{ filePath: string, anchor: { start: number, end: number } | null }}
 */
function parseClaimPath(rawPath) {
  const normalized = toSlash(rawPath);
  const anchorMarkerIndex = normalized.lastIndexOf('#L');
  if (anchorMarkerIndex === -1) {
    return { filePath: normalized, anchor: null };
  }
  const anchor = parseAnchorRange(normalized.slice(anchorMarkerIndex + 2));
  if (anchor === null) {
    return { filePath: normalized, anchor: null };
  }
  return { filePath: normalized.slice(0, anchorMarkerIndex), anchor };
}

/**
 * True when two line-anchor ranges overlap.
 * @param {{ start: number, end: number }} a
 * @param {{ start: number, end: number }} b
 * @returns {boolean}
 */
function anchorsOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Split on ASCII whitespace runs without regex (security hardening).
 * @param {string} text
 * @returns {string[]}
 */
function splitOnWhitespace(text) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Case-fold, collapse whitespace, strip trailing punctuation — the exact-dup
 * normalization from rule 2.
 * @param {string} fact
 * @returns {string}
 */
function normalizeFactText(fact) {
  const collapsed = splitOnWhitespace(fact.trim().toLowerCase()).join(' ');
  let end = collapsed.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(collapsed[end - 1])) end -= 1;
  return collapsed.slice(0, end);
}

/**
 * Token-set Jaccard similarity of two already-normalized facts (rule 3 —
 * lexical only, no embeddings, zero-dep).
 * @param {string} normalizedA
 * @param {string} normalizedB
 * @returns {number}
 */
function jaccardSimilarity(normalizedA, normalizedB) {
  const setA = new Set(normalizedA === '' ? [] : normalizedA.split(' '));
  const setB = new Set(normalizedB === '' ? [] : normalizedB.split(' '));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @typedef {Object} MergeCluster
 * @property {string} rawFact
 * @property {string} rawPath  The claim's own evidence pointer, slash-normalized
 *   (rule 1: `\\`→`/`) but otherwise as given — this is the canonical claim's
 *   output `path` and feeds the dropped-by-cap `unverified` string.
 * @property {string} filePath
 * @property {{ start: number, end: number } | null} anchor
 * @property {'high'|'low'} confidence
 * @property {string} normalizedFact
 * @property {Set<number>} sourceIndices  Distinct input-artifact indices — the
 *   corroboration identity. Always the artifact's own index, independent of
 *   any caller-supplied label, so duplicate/empty `opts.workerIds` entries
 *   can never collapse two distinct artifacts into one corroboration count.
 * @property {Set<string>} sourceLabels  Display labels for `sources` output
 *   (`opts.workerIds[index]` when provided, else the index as a string).
 * @property {number} firstSeenOrder
 * @property {boolean} needsReview
 */

/**
 * Validate the required `maxClaims` config (programmer error — mirrors
 * `fanout`'s config-error stance, `lib/orchestrator/fanout.mjs:80`).
 * @param {unknown} maxClaims
 * @returns {number}
 */
function requireMaxClaims(maxClaims) {
  if (typeof maxClaims !== 'number' || !Number.isFinite(maxClaims) || maxClaims < 1) {
    throw new Error('mergeDiscoveryArtifacts requires opts.maxClaims to be a finite number >= 1');
  }
  return maxClaims;
}

/**
 * Validate the optional `nearDupThreshold` config.
 * @param {unknown} nearDupThreshold
 * @returns {number}
 */
function resolveNearDupThreshold(nearDupThreshold) {
  if (nearDupThreshold === undefined) return DEFAULT_NEAR_DUP_THRESHOLD;
  if (typeof nearDupThreshold !== 'number' || !Number.isFinite(nearDupThreshold) || nearDupThreshold < 0 || nearDupThreshold > 1) {
    throw new Error('mergeDiscoveryArtifacts requires opts.nearDupThreshold to be a finite number between 0 and 1');
  }
  return nearDupThreshold;
}

/**
 * Resolve the display label for one input artifact's `sources` entry —
 * `opts.workerIds[index]` when provided, else the artifact's own index (as a
 * string). This is a label only — corroboration identity is always the
 * artifact index (`MergeCluster.sourceIndices`), never this label, so a
 * duplicate or empty `workerIds` entry can never under-count corroboration.
 * @param {string[]|undefined} workerIds
 * @param {number} index
 * @returns {string}
 */
function resolveSourceId(workerIds, index) {
  const fromOpts = workerIds?.[index];
  return typeof fromOpts === 'string' && fromOpts !== '' ? fromOpts : String(index);
}

/**
 * Find an existing cluster the candidate should merge into, per rules 1-3:
 * the dedup key is `filePath` plus overlapping anchors (anchorless claims on
 * the same file share a key; an anchored/anchorless pair on the same file
 * shares a key only if the facts are near-dup), and a match additionally
 * requires the facts to be exact- or near-duplicate.
 * @param {MergeCluster[]} clusters
 * @param {{ filePath: string, anchor: { start: number, end: number } | null, normalizedFact: string }} candidate
 * @param {number} nearDupThreshold
 * @returns {{ cluster: MergeCluster, kind: 'exact'|'near' } | null}
 */
function findMergeTarget(clusters, candidate, nearDupThreshold) {
  for (const cluster of clusters) {
    if (cluster.filePath !== candidate.filePath) continue;

    const isExact = cluster.normalizedFact === candidate.normalizedFact;
    const isNear = jaccardSimilarity(cluster.normalizedFact, candidate.normalizedFact) >= nearDupThreshold;
    const similar = isExact || isNear;

    const clusterAnchor = cluster.anchor;
    const candidateAnchor = candidate.anchor;
    let pathEligible;
    if (clusterAnchor === null && candidateAnchor === null) {
      pathEligible = true;
    } else if (clusterAnchor !== null && candidateAnchor !== null) {
      pathEligible = anchorsOverlap(clusterAnchor, candidateAnchor);
    } else {
      // Mixed anchored/anchorless: same key only when facts are near-dup.
      pathEligible = similar;
    }

    if (!pathEligible || !similar) continue;
    return { cluster, kind: isExact ? 'exact' : 'near' };
  }
  return null;
}

/**
 * Merge K parallel `@discovery` worker artifacts into one — the fan-in.
 * Downstream consumers (`@tech-design`, `@rubber-duck`, planner) see a single
 * artifact; the fan-out stays invisible. Pure — no I/O, no randomness, no
 * timestamps, and input artifacts are never mutated.
 *
 * Merge rules (applied in this order):
 * 1. Path normalization — split `path` into `{filePath, anchor}`; the dedup
 *    key is `filePath` plus overlapping anchors.
 * 2. Exact dedup — identical `filePath` + identical normalized fact merge;
 *    corroboration counts distinct source artifacts, never duplicate claims
 *    within one artifact; the highest confidence and the union of sources win.
 * 3. Near-dup — same `filePath`, token-set Jaccard similarity of normalized
 *    facts >= `opts.nearDupThreshold` (default 0.8) merge; the longer fact
 *    (and its path) becomes canonical.
 * 4. Corroboration upgrade — `corroboration >= 2` and `confidence: 'low'`
 *    upgrades to `'high'` (legal: every claim already carries an evidence
 *    path); never downgrades.
 * 5. Conflicts are surfaced, never resolved — after rules 2-3, a `filePath`
 *    that still owns >=2 distinct merged claims gets `needsReview: true` on
 *    each; no semantic contradiction detection (that is `@rubber-duck`'s job
 *    downstream).
 * 6. Rank before cap — sort by `corroboration` desc, then confidence
 *    (`high` > `low`), then first-seen input order (stable); take
 *    `opts.maxClaims`. Every overflow claim becomes an `unverified` entry
 *    (`"[UNVERIFIED] — dropped by merge cap: <fact> (<path>)"`, keeping the
 *    validator's literal `[UNVERIFIED]` prefix intact) — no silent drops.
 * 7. Unverified union — concatenate all inputs' `unverified`, exact-dedupe
 *    (case-sensitive full string), preserve first-appearance order.
 * 8. Never re-read files — the merge operates on claims as given; pointer
 *    resolution stays the contract-validator hook's job.
 *
 * An input artifact that fails `validateDiscoveryArtifact` is skipped (never
 * thrown) and counted in `stats.invalidInputs` — one bad worker must not sink
 * the merge (mirrors `fanout`'s `violations`).
 * @param {unknown[]} artifacts
 * @param {MergeDiscoveryArtifactsOpts} opts
 * @returns {MergeDiscoveryArtifactsResult}
 */
export function mergeDiscoveryArtifacts(artifacts, opts) {
  const maxClaims = requireMaxClaims(opts?.maxClaims);
  const nearDupThreshold = resolveNearDupThreshold(opts?.nearDupThreshold);
  const workerIds = opts?.workerIds;

  /** @type {MergeDiscoveryStats} */
  const stats = {
    inputClaims: 0,
    mergedClaims: 0,
    exactDups: 0,
    nearDups: 0,
    corroborated: 0,
    needsReview: 0,
    dropped: 0,
    invalidInputs: 0,
  };

  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { merged: { agentName: 'discovery', claims: [], unverified: [] }, stats };
  }

  /** @type {MergeCluster[]} */
  const clusters = [];
  /** @type {string[]} */
  const unverifiedUnion = [];
  const seenUnverified = new Set();
  let order = 0;

  artifacts.forEach((artifact, artifactIndex) => {
    const { ok } = validateDiscoveryArtifact(artifact);
    if (!ok) {
      stats.invalidInputs += 1;
      return;
    }
    const typed = /** @type {DiscoveryArtifact} */ (artifact);
    const sourceLabel = resolveSourceId(workerIds, artifactIndex);

    for (const claim of typed.claims) {
      stats.inputClaims += 1;
      const { filePath, anchor } = parseClaimPath(claim.path);
      const normalizedFact = normalizeFactText(claim.fact);
      const target = findMergeTarget(clusters, { filePath, anchor, normalizedFact }, nearDupThreshold);

      if (target === null) {
        clusters.push({
          rawFact: claim.fact,
          rawPath: toSlash(claim.path),
          filePath,
          anchor,
          normalizedFact,
          confidence: claim.confidence,
          // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- one Set per unique claim cluster; bounded by the caller's already-validated discovery artifacts, not unbounded user input.
          sourceIndices: new Set([artifactIndex]),
          // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- one Set per unique claim cluster; bounded by the caller's already-validated discovery artifacts, not unbounded user input.
          sourceLabels: new Set([sourceLabel]),
          firstSeenOrder: order,
          needsReview: false,
        });
        order += 1;
        continue;
      }

      const { cluster, kind } = target;
      if (kind === 'exact') stats.exactDups += 1;
      else stats.nearDups += 1;

      cluster.sourceIndices.add(artifactIndex);
      cluster.sourceLabels.add(sourceLabel);
      if (claim.confidence === 'high') cluster.confidence = 'high';
      if (kind === 'near' && claim.fact.length > cluster.rawFact.length) {
        cluster.rawFact = claim.fact;
        cluster.rawPath = toSlash(claim.path);
        cluster.normalizedFact = normalizedFact;
        cluster.anchor = anchor;
      }
    }

    for (const item of typed.unverified) {
      if (!seenUnverified.has(item)) {
        seenUnverified.add(item);
        unverifiedUnion.push(item);
      }
    }
  });

  // Rule 4: corroboration upgrades confidence; never downgrades.
  for (const cluster of clusters) {
    if (cluster.sourceIndices.size >= 2 && cluster.confidence === 'low') {
      cluster.confidence = 'high';
      stats.corroborated += 1;
    }
  }

  // Rule 5: conflicts surfaced, never resolved — grouped by filePath.
  /** @type {Map<string, MergeCluster[]>} */
  const byFilePath = new Map();
  for (const cluster of clusters) {
    const group = byFilePath.get(cluster.filePath) ?? [];
    group.push(cluster);
    byFilePath.set(cluster.filePath, group);
  }
  for (const group of byFilePath.values()) {
    if (group.length < 2) continue;
    stats.needsReview += 1;
    for (const cluster of group) cluster.needsReview = true;
  }

  // Rule 6: rank before cap.
  const confidenceRank = (/** @type {'high'|'low'} */ confidence) => (confidence === 'high' ? 1 : 0);
  const ranked = [...clusters].sort((a, b) => {
    if (b.sourceIndices.size !== a.sourceIndices.size) return b.sourceIndices.size - a.sourceIndices.size;
    const confDelta = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (confDelta !== 0) return confDelta;
    return a.firstSeenOrder - b.firstSeenOrder;
  });

  const kept = ranked.slice(0, maxClaims);
  const overflow = ranked.slice(maxClaims);
  stats.dropped = overflow.length;

  /** @type {MergedDiscoveryClaim[]} */
  const finalClaims = kept.map((cluster) => {
    /** @type {MergedDiscoveryClaim} */
    const claim = {
      fact: cluster.rawFact,
      path: cluster.rawPath,
      confidence: cluster.confidence,
      corroboration: cluster.sourceIndices.size,
      sources: [...cluster.sourceLabels],
    };
    if (cluster.needsReview) claim.needsReview = true;
    return claim;
  });
  stats.mergedClaims = finalClaims.length;

  const droppedUnverified = overflow.map(
    (cluster) => `${DROPPED_BY_CAP_PREFIX} ${cluster.rawFact} (${cluster.rawPath})`
  );

  return {
    merged: {
      agentName: 'discovery',
      claims: finalClaims,
      unverified: [...unverifiedUnion, ...droppedUnverified],
    },
    stats,
  };
}
