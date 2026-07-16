// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/check-session-budget.mjs';

/** @type {string[]} */
let outWrites = [];
/** @type {string[]} */
let errWrites = [];
/** @type {typeof process.stdout.write} */
const realOut = process.stdout.write.bind(process.stdout);
/** @type {typeof process.stderr.write} */
const realErr = process.stderr.write.bind(process.stderr);

// #77: stderr is now a channel that carries meaning, not noise to be swallowed.
// VS Code parses stdout as JSON only on exit 0; on a non-zero exit it reads
// stderr — so the warn and critical messages, which are exactly the ones that
// exit non-zero, have to leave that way or reach nobody.
function capture() {
  outWrites = [];
  errWrites = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        outWrites.push(String(chunk));
        return true;
      }
    );
  process.stderr.write =
    /** @type {typeof process.stderr.write} */ (
      (/** @type {string} */ chunk) => {
        errWrites.push(String(chunk));
        return true;
      }
    );
}

function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/**
 * Build a task.json plus component files sized to hit a target token level.
 * @param {{ budgetClass?: string, sessionBytes?: number }} opts
 * @returns {Promise<string>} task state path
 */
async function makeSession(opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'csb-cli-'));
  const sessionPath = path.join(dir, 'session.md');
  if (opts.sessionBytes) await fsp.writeFile(sessionPath, 'x'.repeat(opts.sessionBytes));

  /** @type {Record<string, unknown>} */
  const state = { sessionPath, loadedSkills: [] };
  if (opts.budgetClass) {
    state.outputContract = { token_budget_class: opts.budgetClass, max_context_sources: 5 };
  }
  const taskStatePath = path.join(dir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  return taskStatePath;
}

test('check-session-budget main() / exits 0 and reaches the model as context', async () => {
  // standard warn=8000 tokens → need < 32000 bytes; use a tiny file.
  const taskStatePath = await makeSession({ budgetClass: 'standard', sessionBytes: 100 });
  capture();
  let code;
  try {
    code = await main([taskStatePath]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  // Exit 0: stdout is parsed as JSON, so the line rides in the documented
  // PostToolUse context envelope rather than as bare text the host would drop.
  const parsed = JSON.parse(outWrites.join(''));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /\[BUDGET:ok\]/);
});

test('check-session-budget main() / exits 1 on warn, with the warning on stderr', async () => {
  // standard warn=8000, critical=16000 tokens → 40000 bytes = 10000 tokens (warn band).
  const taskStatePath = await makeSession({ budgetClass: 'standard', sessionBytes: 40000 });
  capture();
  let code;
  try {
    code = await main([taskStatePath]);
  } finally {
    restore();
  }
  assert.equal(code, 1);
  assert.match(errWrites.join(''), /\[BUDGET:warn\]/);
  assert.equal(outWrites.join(''), '', 'a non-zero exit means the host never parses stdout');
});

test('check-session-budget main() / exits 2 on critical, with the breach on stderr', async () => {
  // standard critical=16000 tokens → 80000 bytes = 20000 tokens (critical band).
  const taskStatePath = await makeSession({ budgetClass: 'standard', sessionBytes: 80000 });
  capture();
  let code;
  try {
    code = await main([taskStatePath]);
  } finally {
    restore();
  }
  // Exit 2 is the documented blocking error, and stderr is what the model is
  // shown — which is the whole point of a critical budget breach.
  assert.equal(code, 2);
  const blob = errWrites.join('');
  assert.match(blob, /\[BUDGET:critical\]/);
  assert.match(blob, /Actions: /);
});

// #87 AC5 — the noise the issue was filed about. An unchanged warn was re-emitted
// on every single PostToolUse, forever, because nothing about it could change.
test('#87 — an unchanged warn is reported once, not on every tool call', async () => {
  const taskStatePath = await makeSession({ budgetClass: 'standard', sessionBytes: 40000 });

  capture();
  let first;
  let second;
  try {
    first = await main([taskStatePath]);
    const firstOut = errWrites.join('');
    assert.equal(first, 1, 'the breach is reported the first time');
    assert.match(firstOut, /\[BUDGET:warn\]/);

    outWrites.length = 0;
    errWrites.length = 0;

    // The next tool call. Nothing about the session changed.
    second = await main([taskStatePath]);
  } finally {
    restore();
  }

  assert.equal(second, 0, 'an unchanged breach does not keep raising a non-zero exit');
  assert.doesNotMatch(
    [...outWrites, ...errWrites].join(''),
    /\[BUDGET:warn\]/,
    'the same warn must not be re-emitted on the next tool call',
  );
});

// #87 — the meter's producer. `tool_response` is what the host feeds back to the
// model, so it is what the budget counts. Ground truth is the captured payload.
test('#87 — the tool result is metered into the context total', async () => {
  const taskStatePath = await makeSession({ budgetClass: 'tiny' });

  capture();
  try {
    // tiny warn = 2000 tokens. One 12 KB tool result = 3000 tokens → warn, from
    // a session whose files on disk are all empty.
    const code = await main([taskStatePath], { toolResponse: 'r'.repeat(12_000) });
    assert.equal(code, 1, 'the tool result alone breached the budget');
  } finally {
    restore();
  }
  assert.match(errWrites.join(''), /Tool results in context/);
});
