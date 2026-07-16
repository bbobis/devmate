// @ts-check
/**
 * E9-04: gate-name drift checking — extractGateClaims contexts, ground-truth
 * diffing against the canonical gate set, and the widened default scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractGateClaims,
  extractDocsClaims,
  buildGroundTruth,
  diffClaims,
  KNOWN_NON_GATE_MILESTONES,
} from '../../lib/docs-drift.mjs';
import { main } from '../../scripts/check-docs-drift.mjs';

test('extractGateClaims finds gate tokens in a gate table', () => {
  const text = [
    '| Gate | Trigger | Auto or human |',
    '|---|---|:---:|',
    '| `lane-set` | Lane classified | Auto |',
    '| `fake-gate` | Something | Auto |',
    '',
    'Unrelated `some-token` outside any gate context.',
  ].join('\n');
  const claims = extractGateClaims(text);
  assert.ok(claims.includes('lane-set'));
  assert.ok(claims.includes('fake-gate'));
  assert.ok(!claims.includes('some-token'), 'non-gate context token must not be claimed');
});

test('a gate not in VALID_GATES is reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-gate-'));
  const doc = join(dir, 'doc.md');
  await writeFile(doc, 'Advance the `made-up-gate` gate when ready.\n', 'utf8');
  const claims = await extractDocsClaims(doc, { claimTypes: ['gate-name'] });
  const truth = await buildGroundTruth({
    hooksPath: join(dir, 'missing-hooks.json'),
    configSchemaPath: join(dir, 'missing-schema.json'),
  });
  const violations = diffClaims(claims, truth);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.claim.value, 'made-up-gate');
});

test('a valid gate passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-gate-ok-'));
  const doc = join(dir, 'doc.md');
  await writeFile(doc, 'Advance the `lane-set` gate, then set `workflowGate` to `impl-started`.\n', 'utf8');
  const claims = await extractDocsClaims(doc, { claimTypes: ['gate-name'] });
  assert.ok(claims.length >= 2, 'both gate contexts extracted');
  const truth = await buildGroundTruth({
    hooksPath: join(dir, 'missing-hooks.json'),
    configSchemaPath: join(dir, 'missing-schema.json'),
  });
  assert.deepEqual(diffClaims(claims, truth), []);
});

test('non-gate kebab-case is not falsely flagged', () => {
  const text = [
    'Run `check-docs-drift` and inspect `gate-guard.md` for details.',
    'The `post-tool-use` hook wires `lib/gate-guard-core.mjs` in.',
    'Progress markers such as diagnosis-done are prose milestones only — they are **not** `workflowGate` values.',
  ].join('\n');
  const claims = extractGateClaims(text);
  assert.deepEqual(claims, [], `no claims expected, got: ${claims.join(', ')}`);
});

test('known milestone escape: milestone-marked lines are not gate claims', () => {
  for (const term of KNOWN_NON_GATE_MILESTONES) {
    const text = `The \`${term}\` gate is really a milestone, not a workflowGate value.`;
    assert.deepEqual(extractGateClaims(text), [], `${term} must be escaped on milestone lines`);
  }
});

test('widened docsFiles default includes README and ARCHITECTURE', async () => {
  // Run main() against a temp root shaped like the repo: the widened default
  // gate scan must pick up gate claims from README.md and docs/ARCHITECTURE.md.
  const root = await mkdtemp(join(tmpdir(), 'drift-root-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });
  await writeFile(join(root, 'CHANGELOG.md'), 'nothing here\n', 'utf8');
  await writeFile(join(root, 'docs', 'hooks.md'), 'nothing here\n', 'utf8');
  await writeFile(join(root, 'docs', 'SCRIPTS.md'), 'nothing\n', 'utf8');
  await writeFile(join(root, 'docs', 'PATTERNS.md'), 'nothing\n', 'utf8');
  await writeFile(join(root, 'docs', 'SYSTEM_OVERVIEW.md'), 'nothing\n', 'utf8');
  await writeFile(join(root, 'docs', 'workflow.md'), 'nothing\n', 'utf8');
  await writeFile(join(root, 'docs', 'gate-guard.md'), 'nothing\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'Advance the `bogus-readme-gate` gate.\n', 'utf8');
  await writeFile(
    join(root, 'docs', 'ARCHITECTURE.md'),
    '| Gate | Trigger |\n|---|---|\n| `bogus-arch-gate` | x |\n',
    'utf8'
  );
  await writeFile(join(root, 'agents', 'sample.agent.md'), '[INTERNAL GATE] `bogus-agent-gate` advance.\n', 'utf8');

  /** @type {string[]} */
  const errChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {typeof process.stderr.write} */ (
    (/** @type {string | Uint8Array} */ chunk) => {
      errChunks.push(String(chunk));
      return true;
    }
  );
  let code;
  try {
    code = await main([], { rootOverride: root });
  } finally {
    process.stderr.write = origWrite;
  }
  const out = errChunks.join('');
  assert.equal(code, 1, 'bogus gates in widened sources must fail the check');
  assert.ok(out.includes('bogus-readme-gate'), 'README.md is scanned');
  assert.ok(out.includes('bogus-arch-gate'), 'docs/ARCHITECTURE.md is scanned');
  assert.ok(out.includes('bogus-agent-gate'), 'agents/*.agent.md are scanned');
});
