// @ts-check
/**
 * FO-3: tests for lib/discovery/scan.mjs — the deterministic, zero-LLM-cost
 * candidate scan. Every test builds its own temp-dir fixture repo; nothing
 * is ever written into the actual repo tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildScanWorkers,
  mergeCandidates,
  mirrorPath,
  normalizeCandidatePath,
  resolveMaxSources,
  runDiscoveryScan,
  scanByContent,
  scanByImports,
  scanByName,
  scanByTestMirror,
  walkRepoFiles,
} from '../../../lib/discovery/scan.mjs';
import { fanout } from '../../../lib/orchestrator/fanout.mjs';

/**
 * Build a small fixture repo under a fresh temp dir:
 *   lib/gate/guard.mjs        — imports lib/gate/helper.mjs
 *   lib/gate/helper.mjs
 *   test/lib/gate/guard.test.mjs   — mirror of lib/gate/guard.mjs
 *   docs/gate-notes.md         — content-only hit
 *   assets/logo.bin             — binary (NUL byte)
 *   assets/huge.txt             — > 1 MiB
 * @returns {Promise<string>} the fixture repo root
 */
async function buildFixtureRepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'discovery-scan-'));
  await fsp.mkdir(join(root, 'lib', 'gate'), { recursive: true });
  await fsp.mkdir(join(root, 'test', 'lib', 'gate'), { recursive: true });
  await fsp.mkdir(join(root, 'docs'), { recursive: true });
  await fsp.mkdir(join(root, 'assets'), { recursive: true });

  await fsp.writeFile(
    join(root, 'lib', 'gate', 'guard.mjs'),
    "// @ts-check\nimport { helperFn } from './helper.mjs';\nexport function guard() { return helperFn(); }\n",
    'utf8'
  );
  await fsp.writeFile(
    join(root, 'lib', 'gate', 'helper.mjs'),
    '// @ts-check\nexport function helperFn() { return true; }\n',
    'utf8'
  );
  await fsp.writeFile(
    join(root, 'test', 'lib', 'gate', 'guard.test.mjs'),
    "import { guard } from '../../../lib/gate/guard.mjs';\n// test\n",
    'utf8'
  );
  await fsp.writeFile(join(root, 'docs', 'gate-notes.md'), '# Notes\nThe guard gate protects entry.\n', 'utf8');
  await fsp.writeFile(join(root, 'assets', 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  await fsp.writeFile(join(root, 'assets', 'huge.txt'), 'x'.repeat(1024 * 1024 + 10), 'utf8');

  return root;
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// normalizeCandidatePath
// ---------------------------------------------------------------------------

test('normalizeCandidatePath › resolves a relative repo path', () => {
  const rel = normalizeCandidatePath('/repo', 'lib/x.mjs');
  assert.equal(rel, 'lib/x.mjs');
});

test('normalizeCandidatePath › normalizes Windows backslash separators', () => {
  const rel = normalizeCandidatePath('/repo', 'lib\\gate\\guard.mjs');
  assert.equal(rel, 'lib/gate/guard.mjs');
});

test('normalizeCandidatePath › accepts an absolute path inside repoRoot', () => {
  // Derive the "absolute path" the same OS-canonical way repoRoot itself is
  // resolved, so this test is meaningful on both POSIX and Windows CI.
  const root = resolve('/repo');
  const abs = join(root, 'lib', 'x.mjs');
  const rel = normalizeCandidatePath(root, abs);
  assert.equal(rel, 'lib/x.mjs');
});

test('normalizeCandidatePath › rejects a traversal that escapes repoRoot', () => {
  const rel = normalizeCandidatePath('/repo', '../outside.mjs');
  assert.equal(rel, null);
});

test('normalizeCandidatePath › rejects a path outside repoRoot with an absolute prefix', () => {
  const rel = normalizeCandidatePath('/repo', '/etc/passwd');
  assert.equal(rel, null);
});

test('normalizeCandidatePath › rejects an empty or non-string path', () => {
  assert.equal(normalizeCandidatePath('/repo', ''), null);
  assert.equal(normalizeCandidatePath('/repo', /** @type {any} */ (null)), null);
});

// ---------------------------------------------------------------------------
// mirrorPath
// ---------------------------------------------------------------------------

test('mirrorPath › lib path maps to its test/ mirror', () => {
  assert.equal(mirrorPath('lib/gate/guard.mjs'), 'test/lib/gate/guard.test.mjs');
});

test('mirrorPath › test/ mirror maps back to its lib path', () => {
  assert.equal(mirrorPath('test/lib/gate/guard.test.mjs'), 'lib/gate/guard.mjs');
});

test('mirrorPath › a test/ path with no .test. infix has no mirror', () => {
  assert.equal(mirrorPath('test/fixtures/data.json'), null);
});

test('mirrorPath › a path with no extension has no mirror', () => {
  assert.equal(mirrorPath('README'), null);
});

// ---------------------------------------------------------------------------
// walkRepoFiles
// ---------------------------------------------------------------------------

test('walkRepoFiles › walks the fixture repo and skips nothing unexpected', async () => {
  const root = await buildFixtureRepo();
  try {
    const files = await walkRepoFiles(root);
    const rels = files.map((f) => normalizeCandidatePath(root, f)).sort();
    assert.ok(rels.includes('lib/gate/guard.mjs'));
    assert.ok(rels.includes('test/lib/gate/guard.test.mjs'));
    assert.ok(rels.includes('assets/logo.bin'));
  } finally {
    await cleanup(root);
  }
});

test('walkRepoFiles › honors an aborted signal by stopping early', async () => {
  const root = await buildFixtureRepo();
  try {
    const controller = new AbortController();
    controller.abort();
    const files = await walkRepoFiles(root, { signal: controller.signal });
    assert.equal(files.length, 0);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// scanByName
// ---------------------------------------------------------------------------

test('scanByName › matches basenames case-insensitively', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByName(root, ['GUARD']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('lib/gate/guard.mjs'));
    assert.ok(paths.includes('test/lib/gate/guard.test.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('scanByName › matches kebab/camel-flattened terms', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByName(root, ['gate_notes']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('docs/gate-notes.md'));
  } finally {
    await cleanup(root);
  }
});

test('scanByName › returns no candidates for a term matching nothing', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByName(root, ['zzz-nonexistent-term']);
    assert.equal(candidates.length, 0);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// scanByContent — git-grep path and the pure-Node fallback
// ---------------------------------------------------------------------------

test('scanByContent › finds a content match (git-absent fixture, pure-Node fallback)', async () => {
  const root = await buildFixtureRepo();
  try {
    // This repo has no .git — scanByContent must use the pure-Node fallback
    // and still find the match (git-vs-fallback is an implementation detail).
    const candidates = await scanByContent(root, ['helperFn']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('lib/gate/guard.mjs'));
    assert.ok(paths.includes('lib/gate/helper.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('scanByContent › fallback skips binary and oversized files', async () => {
  const root = await buildFixtureRepo();
  try {
    // The binary file contains a NUL byte and the huge file is > 1 MiB;
    // neither should surface even though 'x' matches huge.txt's content.
    const candidates = await scanByContent(root, ['x']);
    const paths = candidates.map((c) => c.path);
    assert.ok(!paths.includes('assets/huge.txt'));
    assert.ok(!paths.includes('assets/logo.bin'));
  } finally {
    await cleanup(root);
  }
});

test('scanByContent › empty term list yields no candidates', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByContent(root, ['', '   ']);
    assert.equal(candidates.length, 0);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// scanByImports
// ---------------------------------------------------------------------------

test('scanByImports › resolves a forward edge from an explicit seed file', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByImports(root, [], ['lib/gate/guard.mjs']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('lib/gate/helper.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('scanByImports › resolves a reverse edge (importer of a seed file)', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByImports(root, [], ['lib/gate/helper.mjs']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('lib/gate/guard.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('scanByImports › derives seeds from seedTerms when no seedFiles given', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByImports(root, ['guard'], []);
    // guard.mjs is the top by-name hit for 'guard'; its forward edge is helper.mjs.
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('lib/gate/helper.mjs'));
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// scanByTestMirror
// ---------------------------------------------------------------------------

test('scanByTestMirror › finds the existing test/ mirror of a seed file', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByTestMirror(root, [], ['lib/gate/guard.mjs']);
    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes('test/lib/gate/guard.test.mjs'));
  } finally {
    await cleanup(root);
  }
});

test('scanByTestMirror › omits a mirror that does not exist on disk', async () => {
  const root = await buildFixtureRepo();
  try {
    const candidates = await scanByTestMirror(root, [], ['lib/gate/helper.mjs']);
    assert.equal(candidates.length, 0);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// resolveMaxSources
// ---------------------------------------------------------------------------

test('resolveMaxSources › maps budget classes to the documented caps', () => {
  assert.equal(resolveMaxSources('tiny'), 3);
  assert.equal(resolveMaxSources('standard'), 10);
  assert.equal(resolveMaxSources('large'), 999);
});

// ---------------------------------------------------------------------------
// mergeCandidates
// ---------------------------------------------------------------------------

test('mergeCandidates › unions strategies for the same path and sums score components', () => {
  const { candidates, dropped } = mergeCandidates(
    [
      { strategy: 'scan-by-name', candidates: [{ path: 'lib/x.mjs', hits: 2, why: 'name match' }] },
      { strategy: 'scan-by-content', candidates: [{ path: 'lib/x.mjs', hits: 3, why: 'content match' }] },
    ],
    { maxSources: 10, repoRoot: '/repo' }
  );
  assert.equal(dropped, 0);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].strategies, ['scan-by-content', 'scan-by-name']);
  assert.equal(candidates[0].hits, 5);
  // score = 2 strategies * 10 + min(5, 20) + 0 proximity bonus = 25.
  assert.equal(candidates[0].score, 25);
});

test('mergeCandidates › sorts by score desc, then path asc on ties', () => {
  const { candidates } = mergeCandidates(
    [
      {
        strategy: 'scan-by-name',
        candidates: [
          { path: 'lib/b.mjs', hits: 1, why: 'name match' },
          { path: 'lib/a.mjs', hits: 1, why: 'name match' },
        ],
      },
    ],
    { maxSources: 10, repoRoot: '/repo' }
  );
  assert.deepEqual(candidates.map((c) => c.path), ['lib/a.mjs', 'lib/b.mjs']);
});

test('mergeCandidates › caps at maxSources and reports dropped (never silent)', () => {
  const raw = Array.from({ length: 5 }, (_, i) => ({ path: `lib/f${i}.mjs`, hits: 1, why: 'name match' }));
  const { candidates, dropped } = mergeCandidates([{ strategy: 'scan-by-name', candidates: raw }], {
    maxSources: 2,
    repoRoot: '/repo',
  });
  assert.equal(candidates.length, 2);
  assert.equal(dropped, 3);
});

test('mergeCandidates › drops a candidate whose path escapes repoRoot and counts it in dropped', () => {
  const { candidates, dropped } = mergeCandidates(
    [{ strategy: 'scan-by-name', candidates: [{ path: '../../etc/passwd', hits: 1, why: 'x' }] }],
    { maxSources: 10, repoRoot: '/repo' }
  );
  assert.equal(candidates.length, 0);
  assert.equal(dropped, 1);
});

test('mergeCandidates › normalizes Windows separators before merging', () => {
  const { candidates } = mergeCandidates(
    [{ strategy: 'scan-by-name', candidates: [{ path: 'lib\\gate\\guard.mjs', hits: 1, why: 'x' }] }],
    { maxSources: 10, repoRoot: '/repo' }
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, 'lib/gate/guard.mjs');
});

test('mergeCandidates › awards a seedProximity bonus for a same-directory candidate', () => {
  const { candidates } = mergeCandidates(
    [{ strategy: 'scan-by-name', candidates: [{ path: 'lib/gate/other.mjs', hits: 0, why: 'x' }] }],
    { maxSources: 10, repoRoot: '/repo', seedFiles: ['lib/gate/guard.mjs'] }
  );
  // score = 1 strategy * 10 + min(0, 20) + 5 proximity bonus = 15.
  assert.equal(candidates[0].score, 15);
});

// ---------------------------------------------------------------------------
// buildScanWorkers + runDiscoveryScan (integration)
// ---------------------------------------------------------------------------

test('buildScanWorkers › each worker returns a valid, contract-compliant WorkerReturn', async () => {
  const root = await buildFixtureRepo();
  try {
    const { workers } = buildScanWorkers({ repoRoot: root, seedTerms: ['guard'] });
    assert.equal(workers.length, 4);
    for (const worker of workers) {
      const ret = await worker();
      assert.equal(typeof ret.workerId, 'string');
      assert.ok(ret.workerId.startsWith('scan-'));
      assert.equal(ret.artifactWritten, null);
      assert.equal(ret.debugMode, false);
      assert.equal(ret.rawTranscriptPath, null);
      assert.equal(ret.tokenNotes, 'deterministic scan — 0 LLM tokens');
      assert.ok(ret.finding.length <= 500);
      assert.ok(ret.nextRecommendedStep.length <= 200);
    }
  } finally {
    await cleanup(root);
  }
});

test('buildScanWorkers › a hits tie breaks deterministically by path, not filesystem order', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'discovery-scan-tie-'));
  try {
    await fsp.mkdir(join(root, 'lib'), { recursive: true });
    // Both files match the term "widget" exactly once by name — a hits tie.
    // Regardless of which the filesystem returns first, the reported `top:`
    // candidate must be the alphabetically-first path (z- vs a- catches an
    // unstable/insertion-order-dependent tie-break).
    await fsp.writeFile(join(root, 'lib', 'z-widget.mjs'), '// @ts-check\nexport function z() {}\n', 'utf8');
    await fsp.writeFile(join(root, 'lib', 'a-widget.mjs'), '// @ts-check\nexport function a() {}\n', 'utf8');

    const { workers } = buildScanWorkers({ repoRoot: root, seedTerms: ['widget'] });
    const byNameWorker = workers[0];
    const ret = await byNameWorker();
    assert.match(ret.finding, /top: lib\/a-widget\.mjs/);
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › merges all four strategies into a ranked, capped artifact', async () => {
  const root = await buildFixtureRepo();
  try {
    const result = await runDiscoveryScan({ repoRoot: root, seedTerms: ['guard'], maxSources: 5 });
    assert.equal(result.insufficient, false);
    assert.deepEqual(result.violations, []);
    assert.ok(result.candidates.length > 0);
    assert.ok(result.candidates.some((c) => c.path === 'lib/gate/guard.mjs'));
    // Stable, descending score order.
    for (let i = 1; i < result.candidates.length; i++) {
      assert.ok(result.candidates[i - 1].score >= result.candidates[i].score);
    }
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › throws on missing repoRoot (programmer error, not operational)', async () => {
  await assert.rejects(
    () => runDiscoveryScan({ repoRoot: '', seedTerms: ['x'] }),
    /repoRoot/
  );
});

test('runDiscoveryScan › throws on empty seedTerms (programmer error, not operational)', async () => {
  const root = await buildFixtureRepo();
  try {
    await assert.rejects(() => runDiscoveryScan({ repoRoot: root, seedTerms: [] }), /seedTerms/);
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › throws on a negative maxSources (programmer error, not a silent empty result)', async () => {
  const root = await buildFixtureRepo();
  try {
    await assert.rejects(
      () => runDiscoveryScan({ repoRoot: root, seedTerms: ['guard'], maxSources: -1 }),
      /maxSources/
    );
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › throws on a non-integer maxSources', async () => {
  const root = await buildFixtureRepo();
  try {
    await assert.rejects(
      () => runDiscoveryScan({ repoRoot: root, seedTerms: ['guard'], maxSources: 2.5 }),
      /maxSources/
    );
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › throws on a non-positive timeoutMs', async () => {
  const root = await buildFixtureRepo();
  try {
    await assert.rejects(
      () => runDiscoveryScan({ repoRoot: root, seedTerms: ['guard'], timeoutMs: 0 }),
      /timeoutMs/
    );
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › a hung strategy is aborted at timeoutMs and the batch still completes', async () => {
  const root = await buildFixtureRepo();
  try {
    // Build the real workers, then splice in one that ignores its deadline
    // until the AbortSignal fires — proves kill-resistance end to end
    // without relying on real git-grep process timing.
    const { workers, store } = buildScanWorkers({ repoRoot: root, seedTerms: ['guard'] });
    let sawAbort = false;
    /** @type {import('../../../lib/types.mjs').FanoutWorker} */
    const hungWorker = (signal) =>
      new Promise((res) => {
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            // Resolve late — after the deadline has already won the race.
            setTimeout(
              () =>
                res({
                  workerId: 'scan-by-name',
                  finding: 'late',
                  sourcePointer: { path: '.', lineRange: null, reason: 'late', confidence: 0.1, freshness: new Date().toISOString(), kind: 'file' },
                  confidence: 0.1,
                  artifactWritten: null,
                  nextRecommendedStep: 'n/a',
                  tokenNotes: 'deterministic scan — 0 LLM tokens',
                  debugMode: false,
                  rawTranscriptPath: null,
                  returnedAt: new Date().toISOString(),
                }),
              5
            );
          },
          { once: true }
        );
      });
    const patched = [hungWorker, workers[1], workers[2], workers[3]];

    // The real strategy workers finish in well under a second on this tiny
    // fixture repo; timeoutMs only needs to be short enough that the test is
    // fast, and long enough that the real workers are not falsely timed out.
    const res = await fanout(patched, { budgetClass: 'standard', timeoutMs: 2000, minSuccessRate: 0.5 });

    assert.equal(sawAbort, true);
    assert.ok(res.violations.includes('scan-by-name') || res.violations.length >= 1);
    assert.ok(res.succeeded >= 1);
    void store; // side-channel store unused by the hung fake, present for shape parity
  } finally {
    await cleanup(root);
  }
});

test('runDiscoveryScan › insufficient surfaces when at least half the strategies fail', async () => {
  const root = await buildFixtureRepo();
  try {
    const { workers } = buildScanWorkers({ repoRoot: root, seedTerms: ['guard'] });
    const failing = () => Promise.reject(new Error('boom'));
    // 3 of 4 fail → succeeded/planned = 0.25, below the 0.5 floor.
    const patched = [failing, failing, failing, workers[0]];

    const res = await fanout(patched, { budgetClass: 'standard', minSuccessRate: 0.5 });
    assert.equal(res.succeeded, 1);
    assert.equal(res.insufficient, true);
  } finally {
    await cleanup(root);
  }
});
