// @ts-check
// FO-6: writeDiscoveryFacts — persisting merged discovery claims as ledger
// facts. Covers schema conformance, the needsReview / missing-file / invalid
// skips, per-task idempotency (stale-then-append), edit-fact survival, the
// mergedArtifactPath variant, and the result-object error paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contentDigest16,
  DISCOVERY_FACT_TOOL,
  writeDiscoveryFacts,
} from '../../../lib/memory/discovery-facts.mjs';
import { collectActiveFacts } from '../../../lib/memory/active-facts.mjs';
import { parseJsonl } from '../../../lib/json-io.mjs';

/** @typedef {import('../../../lib/types.mjs').FactEntry} FactEntry */

/**
 * Build a temp repo root with the given files (relative path -> content).
 * @param {Record<string, string>} files
 * @returns {Promise<string>}
 */
async function buildRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'discovery-facts-'));
  // @bounded-alloc — writes the handful of fixture files declared by this test case.
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  return root;
}

/**
 * @param {string} root
 * @returns {Promise<void>}
 */
async function cleanup(root) {
  await fsp.rm(root, { recursive: true, force: true });
}

/**
 * Read the ledger's parsed entries ([] when absent).
 * @param {string} ledgerPath
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readLedger(ledgerPath) {
  try {
    const raw = await fsp.readFile(ledgerPath, 'utf8');
    return /** @type {Record<string, unknown>[]} */ (parseJsonl(raw));
  } catch {
    return [];
  }
}

/**
 * @param {string} fact
 * @param {string} p
 * @param {Partial<import('../../../lib/types.mjs').MergedDiscoveryClaim>} [over]
 * @returns {import('../../../lib/types.mjs').MergedDiscoveryClaim}
 */
function claim(fact, p, over = {}) {
  return { fact, path: p, confidence: 'high', ...over };
}

/**
 * @param {import('../../../lib/types.mjs').MergedDiscoveryClaim[]} claims
 * @returns {import('../../../lib/types.mjs').MergedDiscoveryArtifact}
 */
function artifact(claims) {
  return { agentName: 'discovery', claims, unverified: [] };
}

test('writeDiscoveryFacts › written facts match the ledger FactEntry schema exactly', async () => {
  const root = await buildRepo({ 'lib/auth.mjs': 'export const a = 1;\n' });
  try {
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      now: () => 5000,
      mergedArtifact: artifact([
        claim('auth validates tokens', 'lib/auth.mjs'),
        claim('auth is rate limited', 'lib/auth.mjs', { confidence: 'low' }),
      ]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.error, null);
    assert.equal(res.facts.length, 2);
    assert.equal(res.ledgerPath, path.join(root, '.devmate/memory/tasks', 'task-1.jsonl'));

    const entries = await readLedger(res.ledgerPath);
    assert.equal(entries.length, 2);
    const [high, low] = /** @type {FactEntry[]} */ (/** @type {unknown} */ (entries));

    // Full schema conformance, field by field.
    assert.equal(high.event, 'fact');
    assert.equal(high.source, 'lib/auth.mjs');
    assert.equal(high.tool, DISCOVERY_FACT_TOOL);
    assert.equal(high.lane, 'feature');
    assert.deepEqual(high.tags, ['ext:mjs', 'dir:lib']);
    assert.equal(high.summary, 'auth validates tokens');
    assert.equal(high.confidence, 0.9);
    assert.equal(high.stepId, 'merge-discovery');
    assert.equal(high.firstEdit, false);
    assert.equal(low.confidence, 0.6);

    // Freshness anchor: 16-hex digest of the referenced file's content.
    const expected = contentDigest16('export const a = 1;\n');
    assert.match(String(high.contentDigest), /^[0-9a-f]{16}$/);
    assert.equal(high.contentDigest, expected);

    // Key: (file, claim text) identity — path + 8-hex claim digest.
    const claimDigest = createHash('sha256')
      .update('auth validates tokens', 'utf8')
      .digest('hex')
      .slice(0, 8);
    assert.equal(high.key, `lib/auth.mjs:${claimDigest}`);

    // Distinct ts per fact in the batch (ts-keyed stale mechanism safety).
    assert.equal(high.ts, 5000);
    assert.equal(low.ts, 5001);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › needsReview claims never enter memory', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n', 'lib/b.mjs': 'b\n' });
  try {
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: artifact([
        claim('kept', 'lib/a.mjs'),
        claim('conflicted', 'lib/b.mjs', { needsReview: true }),
      ]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.facts.length, 1);
    assert.equal(res.skippedNeedsReview, 1);
    const entries = await readLedger(res.ledgerPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]['summary'], 'kept');
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › a claim whose file is missing is skipped, counted, never written', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n' });
  try {
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: artifact([
        claim('kept', 'lib/a.mjs'),
        claim('born stale', 'lib/ghost.mjs'),
      ]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.facts.length, 1);
    assert.equal(res.skippedMissingSource, 1);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › invalid claims (shape, confidence, escaping path) are counted', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n' });
  try {
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: artifact(/** @type {any[]} */ ([
        claim('kept', 'lib/a.mjs'),
        null,
        { fact: '', path: 'lib/a.mjs', confidence: 'high' },
        { fact: 'bad confidence', path: 'lib/a.mjs', confidence: 'medium' },
        { fact: 'escapes root', path: '../outside.mjs', confidence: 'high' },
        { fact: 'absolute path', path: '/etc/passwd', confidence: 'high' },
      ])),
    });
    assert.equal(res.ok, true);
    assert.equal(res.facts.length, 1);
    assert.equal(res.skippedInvalid, 5);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › idempotent per task: a re-run replaces the prior batch, not duplicates it', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n', 'lib/b.mjs': 'b\n' });
  try {
    const first = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      now: () => 1000,
      mergedArtifact: artifact([claim('old claim', 'lib/a.mjs')]),
    });
    assert.equal(first.ok, true);
    assert.equal(first.staledPrior, 0);

    const second = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      now: () => 2000,
      mergedArtifact: artifact([claim('new claim', 'lib/b.mjs')]),
    });
    assert.equal(second.ok, true);
    assert.equal(second.staledPrior, 1);

    const entries = await readLedger(second.ledgerPath);
    const { active } = collectActiveFacts(entries);
    const discovery = active.filter((f) => f.tool === DISCOVERY_FACT_TOOL);
    assert.equal(discovery.length, 1, 'exactly one active batch');
    assert.equal(discovery[0].summary, 'new claim');
    // The superseded fact is still in the file, but marked stale.
    assert.ok(entries.some((e) => e['event'] === 'stale' && e['stalledFactTs'] === 1000));
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › edit facts for the same source survive an idempotent re-run', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n' });
  try {
    const ledgerPath = path.join(root, '.devmate/memory/tasks', 'task-1.jsonl');
    await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
    const editFact = {
      event: 'fact', key: 'lib/a.mjs:999', source: 'lib/a.mjs', tool: 'write_file',
      lane: 'feature', tags: ['ext:mjs', 'dir:lib'], summary: 'write_file edited a.mjs',
      confidence: 0.8, ts: 999, stepId: '1', firstEdit: true,
    };
    await fsp.writeFile(ledgerPath, JSON.stringify(editFact) + '\n', 'utf8');

    for (const run of [1, 2]) {
      const res = await writeDiscoveryFacts({
        taskId: 'task-1',
        lane: 'feature',
        repoRoot: root,
        now: () => 1000 * run,
        mergedArtifact: artifact([claim('discovery claim', 'lib/a.mjs')]),
      });
      assert.equal(res.ok, true);
    }

    const { active } = collectActiveFacts(await readLedger(ledgerPath));
    assert.ok(
      active.some((f) => f.tool === 'write_file'),
      'edit fact still active after two discovery re-runs',
    );
    assert.equal(active.filter((f) => f.tool === DISCOVERY_FACT_TOOL).length, 1);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › reads the merged artifact from mergedArtifactPath', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n' });
  try {
    const artifactRel = '.devmate/state/discovery-merged.json';
    await fsp.mkdir(path.join(root, '.devmate/state'), { recursive: true });
    await fsp.writeFile(
      path.join(root, artifactRel),
      JSON.stringify(artifact([claim('from disk', 'lib/a.mjs')])),
      'utf8',
    );
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifactPath: artifactRel,
    });
    assert.equal(res.ok, true);
    assert.equal(res.facts.length, 1);
    assert.equal(res.facts[0].summary, 'from disk');
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › invalid artifact and invalid taskId return error results, never throw', async () => {
  const root = await buildRepo({});
  try {
    const noArtifact = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
    });
    assert.equal(noArtifact.ok, false);
    assert.match(String(noArtifact.error), /invalid merged artifact/);

    const badShape = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: /** @type {any} */ ({ agentName: 'discovery', claims: 'nope' }),
    });
    assert.equal(badShape.ok, false);
    assert.match(String(badShape.error), /invalid merged artifact/);

    const badTask = await writeDiscoveryFacts({
      taskId: '../escape',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: artifact([]),
    });
    assert.equal(badTask.ok, false);
    assert.match(String(badTask.error), /invalid taskId/);

    // Nothing was written anywhere on the error paths.
    const ledgerDir = path.join(root, '.devmate/memory/tasks');
    /** @type {string[]} */
    let names = [];
    try {
      names = await fsp.readdir(ledgerDir);
    } catch {
      // directory may not exist at all — equally fine
    }
    assert.ok(!names.some((n) => n.endsWith('.jsonl')), `no ledger written, saw ${names}`);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › a non-timeout lock failure returns an error result, never throws', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n', blocker: 'a regular file, not a directory\n' });
  try {
    // The ledger's parent "directory" is a file — lock acquisition cannot
    // create the sentinel and fails with a filesystem error, not a timeout.
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      ledgerPath: path.join(root, 'blocker', 'ledger.jsonl'),
      mergedArtifact: artifact([claim('kept', 'lib/a.mjs')]),
    });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /^lock_failed: /);
  } finally {
    await cleanup(root);
  }
});

test('writeDiscoveryFacts › long claim text is capped to the 120-char summary limit', async () => {
  const root = await buildRepo({ 'lib/a.mjs': 'a\n' });
  try {
    const longFact = 'x'.repeat(300);
    const res = await writeDiscoveryFacts({
      taskId: 'task-1',
      lane: 'feature',
      repoRoot: root,
      mergedArtifact: artifact([claim(longFact, 'lib/a.mjs')]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.facts[0].summary.length, 120);
  } finally {
    await cleanup(root);
  }
});
