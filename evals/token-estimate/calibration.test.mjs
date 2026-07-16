// @ts-check
/**
 * E9-09: calibration eval for the shared token estimator.
 *
 * Reference method: chars-per-token guidance for BPE tokenizers — ~4
 * characters/token for English prose, denser (~3.5) for structured JSON/code.
 * Reference source: https://platform.claude.com/docs/en/build-with-claude/token-counting
 * (Anthropic count_tokens API is the authoritative counter).
 *
 * TODO: calibrate after E9-22 baselines — the committed reference counts below
 * are derived from the documented chars-per-token guidance, not from a live
 * tokenizer run; replace them with real count_tokens output when baselines land.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { estimateTokens } from '../../lib/context/estimate-tokens.mjs';

/** Documented error bound of the bytes/4 heuristic vs a real tokenizer. */
const ERROR_BOUND = 0.2;

/**
 * Representative samples with committed reference token counts.
 * referenceTokens = round(utf8Bytes / charsPerToken) using the documented
 * per-content-type ratios (prose 4.0, json 3.6, code 3.5).
 * @type {Array<{ name: string, text: string, referenceTokens: number }>}
 */
const SAMPLES = [
  {
    name: 'markdown prose',
    text: [
      '# Session budget',
      '',
      'A warning that never fires is worse than no budget system at all, because',
      'it lets the context silently overflow while everyone believes a guard is',
      'watching. This module measures the real component sizes and compares them',
      'against the class thresholds so overruns become observable events.',
    ].join('\n'),
    // 313 bytes / 4.0 chars-per-token ≈ 78
    referenceTokens: 78,
  },
  {
    name: 'json artifact',
    text: JSON.stringify(
      {
        taskId: 'calibration-sample',
        lane: 'feature',
        workflowGate: 'impl-started',
        artifactHashes: { 'docs/spec.md': 'a1b2c3d4e5f60718' },
        budget: 10,
        outputContract: {
          lane: 'feature',
          format: 'pr',
          audience: 'orchestrator',
          token_budget_class: 'standard',
          max_context_sources: 10,
        },
        schemaVersion: 1,
      },
      null,
      2
    ),
    // 383 bytes / 3.6 chars-per-token ≈ 106
    referenceTokens: 106,
  },
  {
    name: 'code sample',
    text: [
      "export function checkBudget(snapshot, budgetClass) {",
      "  const t = THRESHOLDS[budgetClass] || THRESHOLDS.standard;",
      "  const total = snapshot.totalEstimatedTokens;",
      "  if (total < t.warn) {",
      "    return { level: 'ok', thresholdTokens: t.warn };",
      "  }",
      "  return { level: 'warn', thresholdTokens: t.warn };",
      "}",
    ].join('\n'),
    // 316 bytes / 3.5 chars-per-token ≈ 90
    referenceTokens: 90,
  },
];

test('estimateTokens is stable for ASCII', () => {
  assert.equal(estimateTokens('abcdefghijkl'), 3);
  assert.equal(estimateTokens('abcdefghijklm'), 4);
  assert.equal(estimateTokens(''), 0);
});

test('handles multibyte UTF-8 by bytes not code units', () => {
  const emoji = '🎉🎉🎉'; // 3 code points, 6 UTF-16 code units, 12 UTF-8 bytes
  assert.equal(Buffer.byteLength(emoji, 'utf8'), 12);
  assert.equal(estimateTokens(emoji), 3, '12 bytes / 4 = 3, not ceil(6/4)=2');
});

test('string and byte-length inputs agree', () => {
  // @bounded-alloc — iterates the fixed calibration SAMPLES fixture.
  for (const { text } of SAMPLES) {
    assert.equal(estimateTokens(text), estimateTokens(Buffer.byteLength(text, 'utf8')));
  }
});

test('calibration error within bound for md/json/code samples', () => {
  for (const { name, text, referenceTokens } of SAMPLES) {
    const estimate = estimateTokens(text);
    const error = Math.abs(estimate - referenceTokens) / referenceTokens;
    assert.ok(
      error <= ERROR_BOUND,
      `${name}: estimate ${estimate} vs reference ${referenceTokens} — error ${(error * 100).toFixed(1)}% exceeds ±${ERROR_BOUND * 100}%`
    );
  }
});
