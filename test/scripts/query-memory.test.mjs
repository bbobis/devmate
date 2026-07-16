// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/query-memory.mjs';
import { writeDiscoveryFacts } from '../../lib/memory/discovery-facts.mjs';

/** @type {string[]} */
let writes = [];
/** @type {typeof process.stdout.write} */
const realWrite = process.stdout.write.bind(process.stdout);

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
 * Extract the JSON object our script wrote, ignoring any unrelated bytes the
 * test runner may interleave on stdout while the capture hook is active.
 * Our script writes exactly one JSON object per run. We locate it by scanning
 * for a top-level `{...}` span with balanced braces, then JSON.parse it.
 * @returns {any}
 */
function parseScriptOutput() {
  const blob = writes.join('');
  const start = blob.indexOf('{"ok":');
  if (start === -1) {
    throw new Error('no query-memory JSON object captured on stdout');
  }
  let depth = 0;
  for (let i = start; i < blob.length; i += 1) {
    const ch = blob[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(blob.slice(start, i + 1));
      }
    }
  }
  throw new Error('unterminated query-memory JSON object on stdout');
}

/**
 * @param {object[]} rows
 * @returns {Promise<string>}
 */
async function writeLedger(rows) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qm-cli-'));
  const p = path.join(dir, 'memory.jsonl');
  await fsp.writeFile(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

/**
 * @param {Partial<import('../../lib/types.mjs').FactEntry>} over
 * @returns {object}
 */
function fact(over) {
  return {
    event: 'fact',
    source: 'src/x.js',
    tool: 'edit',
    lane: 'bug',
    tags: [],
    summary: 's',
    confidence: 0.5,
    ts: 1,
    stepId: 'none',
    firstEdit: true,
    ...over,
  };
}

test('query-memory main() — valid args produce one parseable JSON line, exit 0', async () => {
  const p = await writeLedger([
    fact({ source: 'a.js', lane: 'bug', ts: 1 }),
    fact({ source: 'b.js', lane: 'bug', ts: 2 }),
    fact({ source: 'c.js', lane: 'feature', ts: 3 }),
  ]);
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', p, '--lane', 'bug', '--top-n', '3']);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.matches));
  assert.ok(parsed.matches.length <= 3);
});

test('query-memory main() — absent ledger exits 0 with empty matches', async () => {
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', '/no/such/path/memory.jsonl']);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.matches, []);
});

test('query-memory main() — default ledger resolves to the canonical repo.jsonl', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qm-default-'));
  const repoDir = path.join(dir, '.devmate', 'state', 'repo');
  await fsp.mkdir(repoDir, { recursive: true });
  await fsp.writeFile(
    path.join(repoDir, 'repo.jsonl'),
    JSON.stringify(fact({ source: 'lib/z.mjs', lane: 'bug', ts: 5 })) + '\n',
  );
  const cwd = process.cwd();
  captureStdout();
  let code;
  try {
    process.chdir(dir);
    code = await main([]); // no --ledger → must use the canonical default
  } finally {
    process.chdir(cwd);
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.matches.some((/** @type {{ source: string }} */ m) => m.source === 'lib/z.mjs'),
    true,
  );
});

test('query-memory main() — top-n caps the number of match objects in stdout', async () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(fact({ source: `f${i}.js`, ts: i }));
  const p = await writeLedger(rows);
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', p, '--top-n', '4']);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.matches.length, 4);
});

// ---- FO-6: discovery facts on the CLI surface ----

test('query-memory main() — discovery facts are output with a [discovery] prefix and kind', async () => {
  const p = await writeLedger([
    fact({ source: 'lib/d.mjs', ts: 1, tool: 'discovery-merge', summary: 'gates fail closed', contentDigest: 'abcd1234abcd1234' }),
    fact({ source: 'lib/e.mjs', ts: 2, tool: 'write_file', summary: 'edited e.mjs' }),
  ]);
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', p]);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  const discovery = parsed.matches.find((/** @type {any} */ m) => m.source === 'lib/d.mjs');
  const edit = parsed.matches.find((/** @type {any} */ m) => m.source === 'lib/e.mjs');
  assert.equal(discovery.kind, 'discovery');
  assert.equal(discovery.summary, '[discovery] gates fail closed');
  assert.equal(edit.kind, undefined);
  assert.equal(edit.summary, 'edited e.mjs');
});

test('query-memory main() — --stale-check annotates drifted discovery facts', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'qm-stale-'));
  await fsp.mkdir(path.join(repoRoot, 'lib'), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, 'lib/fresh.mjs'), 'fresh\n');
  const res = await writeDiscoveryFacts({
    taskId: 'task-1',
    lane: 'feature',
    repoRoot,
    mergedArtifact: {
      agentName: 'discovery',
      claims: [{ fact: 'still true', path: 'lib/fresh.mjs', confidence: 'high' }],
      unverified: [],
    },
  });
  assert.equal(res.ok, true);
  await fsp.writeFile(path.join(repoRoot, 'lib/fresh.mjs'), 'now different\n');
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', res.ledgerPath, '--stale-check', '--root', repoRoot]);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.matches[0].stale, true);
});

test('query-memory main() — --limit is an alias of --top-n', async () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(fact({ source: `f${i}.js`, ts: i }));
  const p = await writeLedger(rows);
  captureStdout();
  let code;
  try {
    code = await main(['--ledger', p, '--limit', '6']);
  } finally {
    restoreStdout();
  }
  assert.equal(code, 0);
  const parsed = parseScriptOutput();
  assert.equal(parsed.matches.length, 6);
});
