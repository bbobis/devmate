// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectContractFiles,
  compareSharedEntry,
  hashContractFiles,
  listFilesUnder,
  normalizeEol,
} from '../../lib/contract-drift.mjs';

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeTmp() {
  const root = mkdtempSync(join(tmpdir(), 'contract-drift-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} root
 * @param {string} rel   POSIX-style relative path.
 * @param {string} text
 */
function writeUnder(root, rel, text) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

// ---- normalizeEol ----

test('normalizeEol - converts CRLF and lone CR to LF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalizeEol('no endings'), 'no endings');
});

// ---- listFilesUnder ----

test('listFilesUnder - recursive, sorted, POSIX-style relative paths', () => {
  const { root, cleanup } = makeTmp();
  try {
    writeUnder(root, 'b.json', '{}');
    writeUnder(root, 'sub/a.json', '{}');
    writeUnder(root, 'sub/deeper/c.json', '{}');
    assert.deepEqual(listFilesUnder(root), ['b.json', 'sub/a.json', 'sub/deeper/c.json']);
  } finally {
    cleanup();
  }
});

test('listFilesUnder - empty for a missing directory', () => {
  const { root, cleanup } = makeTmp();
  try {
    assert.deepEqual(listFilesUnder(join(root, 'nope')), []);
  } finally {
    cleanup();
  }
});

// ---- collectContractFiles + hashContractFiles ----

test('hashContractFiles - identical content hashes identically regardless of CRLF vs LF', () => {
  const { root: a, cleanup: cleanA } = makeTmp();
  const { root: b, cleanup: cleanB } = makeTmp();
  try {
    writeUnder(a, 'docs/schema.json', '{\n  "x": 1\n}\n');
    writeUnder(b, 'docs/schema.json', '{\r\n  "x": 1\r\n}\r\n');
    const hashA = hashContractFiles(collectContractFiles(a, ['docs/schema.json']));
    const hashB = hashContractFiles(collectContractFiles(b, ['docs/schema.json']));
    assert.equal(hashA, hashB);
  } finally {
    cleanA();
    cleanB();
  }
});

test('hashContractFiles - a one-byte content edit changes the hash', () => {
  const { root, cleanup } = makeTmp();
  try {
    writeUnder(root, 'docs/schema.json', '{"v":1}');
    const before = hashContractFiles(collectContractFiles(root, ['docs/schema.json']));
    writeUnder(root, 'docs/schema.json', '{"v":2}');
    const after = hashContractFiles(collectContractFiles(root, ['docs/schema.json']));
    assert.notEqual(before, after);
  } finally {
    cleanup();
  }
});

test('hashContractFiles - a file rename changes the hash (keys are hashed too)', () => {
  const { root, cleanup } = makeTmp();
  try {
    writeUnder(root, 'fixtures/a.json', '{}');
    const before = hashContractFiles(collectContractFiles(root, ['fixtures']));
    rmSync(join(root, 'fixtures', 'a.json'));
    writeUnder(root, 'fixtures/b.json', '{}');
    const after = hashContractFiles(collectContractFiles(root, ['fixtures']));
    assert.notEqual(before, after);
  } finally {
    cleanup();
  }
});

test('collectContractFiles - expands directories recursively and keys by repo-relative path', () => {
  const { root, cleanup } = makeTmp();
  try {
    writeUnder(root, 'docs/schema.json', '{}');
    writeUnder(root, 'fixtures/must-accept/ok.json', '{}');
    writeUnder(root, 'fixtures/manifest.json', '{}');
    const files = collectContractFiles(root, ['docs/schema.json', 'fixtures']);
    assert.deepEqual(
      files.map((f) => f.key),
      ['docs/schema.json', 'fixtures/manifest.json', 'fixtures/must-accept/ok.json'],
    );
  } finally {
    cleanup();
  }
});

// ---- compareSharedEntry ----

test('compareSharedEntry - agreeing files (EOL differences only) report no problems', () => {
  const { root: local, cleanup: cleanLocal } = makeTmp();
  const { root: sibling, cleanup: cleanSibling } = makeTmp();
  try {
    writeUnder(local, 'docs/schema.json', '{\n"x":1\n}\n');
    writeUnder(sibling, 'schema/schema.json', '{\r\n"x":1\r\n}\r\n');
    const problems = compareSharedEntry(local, sibling, {
      local: 'docs/schema.json',
      sibling: 'schema/schema.json',
    });
    assert.deepEqual(problems, []);
  } finally {
    cleanLocal();
    cleanSibling();
  }
});

test('compareSharedEntry - diverging file content is reported', () => {
  const { root: local, cleanup: cleanLocal } = makeTmp();
  const { root: sibling, cleanup: cleanSibling } = makeTmp();
  try {
    writeUnder(local, 'docs/schema.json', '{"v":1}');
    writeUnder(sibling, 'schema/schema.json', '{"v":2}');
    const problems = compareSharedEntry(local, sibling, {
      local: 'docs/schema.json',
      sibling: 'schema/schema.json',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /differs from sibling/);
  } finally {
    cleanLocal();
    cleanSibling();
  }
});

test('compareSharedEntry - directory union catches files missing on either side', () => {
  const { root: local, cleanup: cleanLocal } = makeTmp();
  const { root: sibling, cleanup: cleanSibling } = makeTmp();
  try {
    writeUnder(local, 'fixtures/only-local.json', '{}');
    writeUnder(local, 'fixtures/shared.json', '{}');
    writeUnder(sibling, 'fixtures/shared.json', '{}');
    writeUnder(sibling, 'fixtures/only-sibling.json', '{}');
    const problems = compareSharedEntry(local, sibling, { local: 'fixtures', sibling: 'fixtures' });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes('only-local.json') && p.includes('missing in the sibling')));
    assert.ok(problems.some((p) => p.includes('only-sibling.json') && p.includes('missing locally')));
  } finally {
    cleanLocal();
    cleanSibling();
  }
});

test('compareSharedEntry - missing sibling path is reported', () => {
  const { root: local, cleanup: cleanLocal } = makeTmp();
  const { root: sibling, cleanup: cleanSibling } = makeTmp();
  try {
    writeUnder(local, 'docs/schema.json', '{}');
    const problems = compareSharedEntry(local, sibling, {
      local: 'docs/schema.json',
      sibling: 'schema/schema.json',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /sibling schema\/schema\.json is missing/);
  } finally {
    cleanLocal();
    cleanSibling();
  }
});
