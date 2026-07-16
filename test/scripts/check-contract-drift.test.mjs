// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-contract-drift.mjs';
import { collectContractFiles, hashContractFiles } from '../../lib/contract-drift.mjs';

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeTmp() {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 */
function writeUnder(root, rel, text) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

/**
 * Seed a minimal contract into a fake repo root and return a matching
 * contract spec (expected hash computed from what was written).
 * @param {string} root
 * @returns {{ id: string, expectedHash: string, shared: { local: string, sibling: string }[] }}
 */
function seedContract(root) {
  writeUnder(root, 'docs/thing.schema.json', '{ "v": 1 }\n');
  writeUnder(root, 'test/fixtures/thing/manifest.json', '{ "contractVersion": 3 }\n');
  writeUnder(root, 'test/fixtures/thing/must-accept/ok.json', '{}\n');
  const shared = [
    { local: 'docs/thing.schema.json', sibling: 'schema/thing.schema.json' },
    { local: 'test/fixtures/thing', sibling: 'test/fixtures/thing' },
  ];
  const expectedHash = hashContractFiles(collectContractFiles(root, shared.map((s) => s.local)));
  return { id: 'thing', expectedHash, shared };
}

test('check-contract-drift main - matching hash + absent sibling = pass with a skip notice', async () => {
  const { root, cleanup } = makeTmp();
  try {
    const contract = seedContract(root);
    const code = await main([], {
      rootOverride: root,
      siblingOverride: join(root, 'no-such-sibling'),
      contractsOverride: [contract],
    });
    assert.equal(code, 0);
  } finally {
    cleanup();
  }
});

test('check-contract-drift main - a one-byte edit to a contract file fails the in-repo hash', async () => {
  const { root, cleanup } = makeTmp();
  try {
    const contract = seedContract(root);
    writeUnder(root, 'docs/thing.schema.json', '{ "v": 2 }\n');
    const code = await main([], {
      rootOverride: root,
      siblingOverride: join(root, 'no-such-sibling'),
      contractsOverride: [contract],
    });
    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

test('check-contract-drift main - agreeing sibling passes the cross-repo diff', async () => {
  const { root, cleanup } = makeTmp();
  const { root: sibling, cleanup: cleanupSibling } = makeTmp();
  try {
    const contract = seedContract(root);
    // Sibling copies live at the SIBLING paths, with CRLF endings to prove
    // the comparison is EOL-normalized.
    writeUnder(sibling, 'schema/thing.schema.json', '{ "v": 1 }\r\n');
    writeUnder(sibling, 'test/fixtures/thing/manifest.json', '{ "contractVersion": 3 }\r\n');
    writeUnder(sibling, 'test/fixtures/thing/must-accept/ok.json', '{}\r\n');
    const code = await main([], {
      rootOverride: root,
      siblingOverride: sibling,
      contractsOverride: [contract],
    });
    assert.equal(code, 0);
  } finally {
    cleanup();
    cleanupSibling();
  }
});

test('check-contract-drift main - cross-repo divergence fails when the sibling is present', async () => {
  const { root, cleanup } = makeTmp();
  const { root: sibling, cleanup: cleanupSibling } = makeTmp();
  try {
    const contract = seedContract(root);
    writeUnder(sibling, 'schema/thing.schema.json', '{ "v": 999 }\n');
    writeUnder(sibling, 'test/fixtures/thing/manifest.json', '{ "contractVersion": 3 }\n');
    writeUnder(sibling, 'test/fixtures/thing/must-accept/ok.json', '{}\n');
    const code = await main([], {
      rootOverride: root,
      siblingOverride: sibling,
      contractsOverride: [contract],
    });
    assert.equal(code, 1);
  } finally {
    cleanup();
    cleanupSibling();
  }
});

test('check-contract-drift main - a fixture missing in the sibling corpus fails', async () => {
  const { root, cleanup } = makeTmp();
  const { root: sibling, cleanup: cleanupSibling } = makeTmp();
  try {
    const contract = seedContract(root);
    writeUnder(sibling, 'schema/thing.schema.json', '{ "v": 1 }\n');
    writeUnder(sibling, 'test/fixtures/thing/manifest.json', '{ "contractVersion": 3 }\n');
    // must-accept/ok.json deliberately absent in the sibling.
    const code = await main([], {
      rootOverride: root,
      siblingOverride: sibling,
      contractsOverride: [contract],
    });
    assert.equal(code, 1);
  } finally {
    cleanup();
    cleanupSibling();
  }
});
