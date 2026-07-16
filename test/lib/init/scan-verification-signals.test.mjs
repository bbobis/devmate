// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanVerificationSignals,
  classifyCommand,
} from '../../../lib/init/scan-verification-signals.mjs';

/** @returns {{ root: string, cleanup: () => void }} */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'scan-verif-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('classifyCommand - maps names/commands to conventional categories', () => {
  assert.equal(classifyCommand('test'), 'unit-test');
  assert.equal(classifyCommand('test:e2e playwright'), 'e2e');
  assert.equal(classifyCommand('test:integration'), 'integration');
  assert.equal(classifyCommand('typecheck tsc --noEmit'), 'type-check');
  assert.equal(classifyCommand('lint eslint .'), 'lint');
  assert.equal(classifyCommand('format prettier -w'), 'format');
  assert.equal(classifyCommand('audit npm audit'), 'audit');
  assert.equal(classifyCommand('verify'), 'verify');
  assert.equal(classifyCommand('build rollup -c'), 'build');
  // A build script that runs tsc reads as type-check (tsc is a type-checker) —
  // an ambiguous heuristic the enrichment/human can relabel.
  assert.equal(classifyCommand('build tsc -p .'), 'type-check');
  assert.equal(classifyCommand('deploy'), 'unknown');
});

test('scanVerificationSignals - reads package.json scripts with sources', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', deploy: 'do-deploy' } }),
    );
    const cands = await scanVerificationSignals(root);
    const byCmd = new Map(cands.map((c) => [c.command, c]));
    assert.ok(byCmd.has('npm test'));
    assert.equal(byCmd.get('npm test')?.category, 'unit-test');
    assert.equal(byCmd.get('npm test')?.source, 'package.json#scripts.test');
    assert.ok(byCmd.has('npm run lint'));
    // deploy is still scanned (as a candidate) — promotion filtering happens in infer.
    assert.equal(byCmd.get('npm run deploy')?.category, 'unknown');
  } finally {
    cleanup();
  }
});

test('scanVerificationSignals - reads Makefile targets', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'Makefile'), ['.PHONY: test', 'test:', '\tgo test ./...', 'build:', '\tgo build'].join('\n'));
    const cands = await scanVerificationSignals(root);
    const cmds = cands.map((c) => c.command);
    assert.ok(cmds.includes('make test'));
    assert.ok(cmds.includes('make build'));
    // .PHONY target line must not become a candidate.
    assert.ok(!cmds.some((c) => c.includes('PHONY')));
  } finally {
    cleanup();
  }
});

test('scanVerificationSignals - language markers produce canonical commands', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'go.mod'), 'module example.com/x\n');
    const cands = await scanVerificationSignals(root);
    const cmds = cands.map((c) => c.command);
    assert.ok(cmds.includes('go test ./...'));
    assert.ok(cmds.includes('go vet ./...'));
    assert.ok(cmds.includes('go build ./...'));
  } finally {
    cleanup();
  }
});

test('scanVerificationSignals - harvests inline CI run steps', async () => {
  const { root, cleanup } = makeRoot();
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  test:', '    steps:', '      - run: npm ci', '      - run: npm test'].join('\n'),
    );
    const cands = await scanVerificationSignals(root);
    const ciCands = cands.filter((c) => c.source.startsWith('.github/workflows/'));
    assert.ok(ciCands.some((c) => c.command === 'npm test'));
    assert.ok(ciCands.every((c) => c.confidence <= 0.4));
  } finally {
    cleanup();
  }
});

test('scanVerificationSignals - deterministic ordering (confidence desc, stable)', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }));
    writeFileSync(join(root, 'Makefile'), ['build:', '\tmake-it'].join('\n'));
    const a = await scanVerificationSignals(root);
    const b = await scanVerificationSignals(root);
    assert.deepEqual(a, b);
    // Non-increasing confidence.
    for (let i = 1; i < a.length; i++) {
      assert.ok(a[i - 1].confidence >= a[i].confidence);
    }
  } finally {
    cleanup();
  }
});

test('scanVerificationSignals - empty repo yields no candidates', async () => {
  const { root, cleanup } = makeRoot();
  try {
    assert.deepEqual(await scanVerificationSignals(root), []);
  } finally {
    cleanup();
  }
});
