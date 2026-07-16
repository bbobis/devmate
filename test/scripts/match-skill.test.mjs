// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/match-skill.mjs';

/** @type {string[]} */
let outWrites = [];
/** @type {typeof process.stdout.write} */
const realOut = process.stdout.write.bind(process.stdout);
/** @type {typeof process.stderr.write} */
const realErr = process.stderr.write.bind(process.stderr);

function capture() {
  outWrites = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        outWrites.push(String(chunk));
        return true;
      }
    );
  process.stderr.write =
    /** @type {typeof process.stderr.write} */ (() => true);
}

function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/** @returns {Promise<string>} root of a synthetic skills tree */
async function makeSkillsTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ms-cli-'));
  const dir = path.join(root, 'debugger');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    ['---', 'name: debugger', "triggers: ['debug', 'fix']", "tags: ['debug']", '---', '', '# Debugger'].join('\n'),
  );
  return root;
}

test('match-skill main() / exits 0, prints ranked results', async () => {
  const root = await makeSkillsTree();
  capture();
  let code;
  try {
    code = await main(['debug this please', root]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  const blob = outWrites.join('');
  assert.match(blob, /debugger/);
});

test('match-skill main() / exits 1 with usage message when query missing', async () => {
  capture();
  let code;
  try {
    code = await main([]);
  } finally {
    restore();
  }
  assert.equal(code, 1);
});
