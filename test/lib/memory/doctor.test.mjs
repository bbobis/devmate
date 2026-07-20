// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseMemory } from '../../../lib/memory/doctor.mjs';
import { renderMemory } from '../../../lib/memory/render-memory.mjs';
import { repoLedgerPath, taskLedgerPath } from '../../../lib/memory/paths.mjs';

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'memory-doctor-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} source
 * @param {number} ts
 * @returns {string}
 */
function fact(source, ts) {
  return JSON.stringify({
    event: 'fact',
    key: `${source}:${ts}`,
    source,
    // #150: committed MEMORY.md renders SEMANTIC discovery facts only —
    // pipeline fixtures must be discovery-merge facts to reach the rendered view.
    tool: 'discovery-merge',
    lane: 'feature',
    tags: [],
    summary: `edited ${source}`,
    confidence: 0.8,
    ts,
    stepId: '1',
    firstEdit: true,
  });
}

/**
 * An EDIT-event fact (bare `<tool> edited <file>` telemetry). #150 excludes
 * these from the rendered MEMORY.md, so they must NOT count toward the render
 * invariant. Distinguished only by `tool` (not the discovery marker).
 * @param {string} source
 * @param {number} ts
 * @returns {string}
 */
function editFact(source, ts) {
  return JSON.stringify({
    event: 'fact',
    key: `${source}:${ts}`,
    source,
    tool: 'write_file',
    lane: 'feature',
    tags: [],
    summary: `edited ${source}`,
    confidence: 0.8,
    ts,
    stepId: '1',
    firstEdit: true,
  });
}

test('diagnoseMemory #150: a mixed ledger (discovery + edit facts) is HEALTHY — edit events do not count toward the render invariant', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // 1 discovery fact (renders) + 2 edit events (do NOT render). Pre-#150-fix
    // the doctor compared the FULL active count (3) against the rendered lines
    // (1) and falsely reported the pipeline as broken for this common state.
    writeFileSync(
      repoLedgerPath(root),
      `${fact('lib/a.mjs', 1)}\n${editFact('lib/b.mjs', 2)}\n${editFact('lib/c.mjs', 3)}\n`,
      'utf8',
    );
    await renderMemory(repoLedgerPath(root), join(root, '.devmate', 'MEMORY.md'));

    const d = await diagnoseMemory(root);
    assert.equal(d.render.renderedFactLines, 1, 'only the discovery fact renders');
    assert.equal(d.promotion.activeFacts, 3, 'all three facts are active in the ledger');
    assert.equal(d.ok, true, 'a mixed ledger must be reported healthy');
    assert.equal(d.firstBrokenStage, null);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #150: an edit-only ledger with no discovery section is HEALTHY', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // Only edit events → MEMORY.md legitimately renders zero discovery facts.
    writeFileSync(
      repoLedgerPath(root),
      `${editFact('lib/a.mjs', 1)}\n${editFact('lib/b.mjs', 2)}\n`,
      'utf8',
    );
    await renderMemory(repoLedgerPath(root), join(root, '.devmate', 'MEMORY.md'));

    const d = await diagnoseMemory(root);
    assert.equal(d.render.renderedFactLines, 0);
    assert.equal(d.ok, true, 'an edit-only ledger renders no discovery section and is healthy');
    assert.equal(d.firstBrokenStage, null);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory reports healthy when MEMORY.md matches the repo ledger', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n${fact('lib/b.mjs', 2)}\n`, 'utf8');
    await renderMemory(repoLedgerPath(root), join(root, '.devmate', 'MEMORY.md'));

    const d = await diagnoseMemory(root);
    assert.equal(d.ok, true);
    assert.equal(d.firstBrokenStage, null);
    assert.equal(d.promotion.activeFacts, 2);
    assert.equal(d.render.renderedFactLines, 2);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags collection when nothing has been recorded', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'collection');
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags promotion when task ledgers are staged but repo is empty', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(taskLedgerPath(root, 'task-1'), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'promotion');
    assert.equal(d.collection.pendingFacts, 1);
    assert.equal(d.promotion.activeFacts, 0);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags render when repo has facts but MEMORY.md does not', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    // No MEMORY.md rendered.
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'render');
    assert.equal(d.promotion.activeFacts, 1);
    assert.equal(d.render.renderedFactLines, 0);
  } finally {
    cleanup();
  }
});

// --- #213: unenforced committed-memory notice ---

/**
 * Render a healthy committed MEMORY.md into the root.
 * @param {string} root
 * @returns {Promise<void>}
 */
async function seedHealthyMemory(root) {
  writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
  await renderMemory(repoLedgerPath(root), join(root, '.devmate', 'MEMORY.md'));
}

test('diagnoseMemory #213: committed MEMORY.md with no check-memory workflow raises the non-blocking notice', async () => {
  const { root, cleanup } = makeRoot();
  try {
    await seedHealthyMemory(root);
    const d = await diagnoseMemory(root);
    assert.equal(d.render.exists, true);
    assert.equal(d.guardrailUnenforced, true);
    assert.equal(d.ok, true, 'the notice must be non-blocking (pipeline is healthy)');
    assert.match(d.findings.join('\n'), /promotion guardrails are unenforced/);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #213: a check-memory workflow silences the notice', async () => {
  const { root, cleanup } = makeRoot();
  try {
    await seedHealthyMemory(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'check-memory.yml'),
      'name: check-memory\njobs:\n  x:\n    steps:\n      - run: node .devmate-tool/scripts/check-memory.mjs\n',
      'utf8',
    );
    const d = await diagnoseMemory(root);
    assert.equal(d.guardrailUnenforced, false);
    assert.doesNotMatch(d.findings.join('\n'), /promotion guardrails are unenforced/);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #213: a workflow named differently but referencing check-memory still counts', async () => {
  const { root, cleanup } = makeRoot();
  try {
    await seedHealthyMemory(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yaml'),
      'name: ci\njobs:\n  mem:\n    steps:\n      - run: node scripts/check-memory.mjs\n',
      'utf8',
    );
    const d = await diagnoseMemory(root);
    assert.equal(d.guardrailUnenforced, false);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #213: no committed MEMORY.md means no notice (silent)', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // Repo ledger has facts but nothing rendered — render is flagged, but the
    // guardrail notice must stay silent because there is no committed file yet.
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    const d = await diagnoseMemory(root);
    assert.equal(d.render.exists, false);
    assert.equal(d.guardrailUnenforced, false);
    assert.doesNotMatch(d.findings.join('\n'), /promotion guardrails are unenforced/);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #213: no committed file stays silent even when a workflow is present', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // (no file × workflow present) — the short-circuit must keep it silent.
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'check-memory.yml'),
      'name: check-memory\njobs:\n  x:\n    steps:\n      - run: node scripts/check-memory.mjs\n',
      'utf8',
    );
    const d = await diagnoseMemory(root);
    assert.equal(d.render.exists, false);
    assert.equal(d.guardrailUnenforced, false);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory #213: an unrelated workflow does not silence the notice', async () => {
  const { root, cleanup } = makeRoot();
  try {
    await seedHealthyMemory(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'lint.yml'),
      'name: lint\njobs:\n  lint:\n    steps:\n      - run: npm run lint\n',
      'utf8',
    );
    const d = await diagnoseMemory(root);
    assert.equal(d.guardrailUnenforced, true);
  } finally {
    cleanup();
  }
});
