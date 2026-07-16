// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/validate-skill-split.mjs';

/** @type {string[]} */
let writes = [];
/** @type {typeof process.stdout.write} */
const realWrite = process.stdout.write.bind(process.stdout);

/** Capture stdout while running fn, restoring afterwards. */
function captureStdout() {
  writes = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        writes.push(String(chunk));
        return true;
      }
    );
}

function restoreStdout() {
  process.stdout.write = realWrite;
}

/**
 * Write a skill stub of a given line count into a temp skills tree.
 * @param {string} id
 * @param {number} bodyLines
 * @returns {Promise<string>}  skills root dir
 */
async function makeSkill(id, bodyLines) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vss-'));
  const dir = path.join(root, id);
  await fsp.mkdir(dir, { recursive: true });
  const lines = ['---', `name: ${id}`, "triggers: ['x']", '---', '# Title'];
  for (let i = 0; i < bodyLines; i += 1) lines.push(`line ${i}`);
  await fsp.writeFile(path.join(dir, 'SKILL.md'), lines.join('\n'));
  return root;
}

test('validate-skill-split main() / exits 0 when all skills pass', async () => {
  const root = await makeSkill('small', 3);
  captureStdout();
  let code;
  try {
    code = await main([root]);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  assert.ok(writes.join('').includes('PASS small'));
});

test('validate-skill-split main() / exits 1 on budget violation', async () => {
  // 5 frontmatter/title lines + 40 body lines = 45 > 30 budget.
  const root = await makeSkill('huge', 40);
  captureStdout();
  let code;
  try {
    code = await main([root]);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 1);
  assert.ok(writes.join('').includes('FAIL huge'));
});

test('validate-skill-split main() / exits 0 when no skills found', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vss-empty-'));
  captureStdout();
  let code;
  try {
    code = await main([root]);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  assert.ok(writes.join('').includes('No skills found'));
});
