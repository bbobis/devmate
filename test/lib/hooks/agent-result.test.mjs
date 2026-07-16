// @ts-check
/**
 * How a subagent's return is read off the wire — tested against what models ACTUALLY
 * send, not against the one tidy example the captured fixture happens to contain.
 *
 * The old reader took the span from the first `{` to the last `}` in the agent's
 * whole reply. That works for `@router`, whose return is one line of JSON after one
 * line of prose — and it is the only return anyone ever tested it with. A grill
 * report is nothing like that: it narrates, it quotes code, and the moment its prose
 * contained a brace ("the guard returns `{}` for anonymous callers") the span
 * covered `{}` … `{real}`, parsed as nothing, and the ENTIRE return was discarded —
 * no worker-return file, no artifact, no gate move, and not one word to the model.
 *
 * A completed dispatch left no trace. Every case below is a shape that did that, or
 * would have.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractAgentResult } from '../../../lib/hooks/agent-result.mjs';

/** The contract a grill actually returns, as its card documents it. */
const GRILL = {
  agentName: 'rubber-duck',
  status: 'ok',
  mode: 'grill',
  report: { assumptions: ['claims are always present'], edgeCases: [] },
};

describe('extractAgentResult — messy returns that a model really sends', () => {
  it('finds the contract when the prose before it contains a brace', () => {
    // THE FIELD FAILURE. A first-{-to-last-} span starts at the `{}` in the prose and
    // ends at the contract's closing brace, so it parses as nothing at all.
    const text =
      'I grilled it. The guard returns `{}` for an anonymous caller, so the branch is reachable.\n\n' +
      JSON.stringify(GRILL);

    const out = extractAgentResult(text);
    assert.equal(out.agentName, 'rubber-duck');
    assert.equal(out.empty, false);
    assert.deepEqual(out.result, GRILL);
  });

  it('finds the contract inside a fenced code block', () => {
    const text = `Here is the report:\n\n\`\`\`json\n${JSON.stringify(GRILL, null, 2)}\n\`\`\`\n`;
    assert.deepEqual(extractAgentResult(text).result, GRILL);
  });

  it('prefers the real contract over an example object that precedes it', () => {
    // Agents love to show their work: "I'll return something like {…}" followed by
    // the actual thing. The named object is the conclusion; the sketch is not.
    const text =
      'I will return an object shaped like {"mode": "grill"} once I am done.\n\n' +
      JSON.stringify(GRILL);
    assert.deepEqual(extractAgentResult(text).result, GRILL);
  });

  it('is not fooled by braces inside JSON string values', () => {
    const withBraces = {
      agentName: 'diagnose',
      fixerRecommendation: 'replace `return {}` with a guarded `return null`',
      bugScope: 'backend',
    };
    const out = extractAgentResult(`Diagnosed.\n\n${JSON.stringify(withBraces)}`);
    assert.deepEqual(out.result, withBraces);
  });

  it('reads a bare JSON return with no prose at all', () => {
    assert.deepEqual(extractAgentResult(JSON.stringify(GRILL)).result, GRILL);
  });

  it('reads the captured router shape — prose, then one-line JSON', () => {
    // The one return the wire has actually confirmed. It must keep working.
    const text =
      'Classifying the task by intent and scope now.\n\n' +
      '{"agentName":"router","lane":"feature","budgetClass":"standard","confidence":0.94}';
    const out = extractAgentResult(text);
    assert.equal(out.agentName, 'router');
    assert.equal(out.result?.['lane'], 'feature');
  });

  it('returns the contract even when the agent forgot to sign it', () => {
    // `agentName` is now resolved from the host's SubagentStart index, so an unsigned
    // return is no longer thrown away — the body still has to come back.
    const unsigned = { mode: 'grill', assumptions: [] };
    const out = extractAgentResult(`Done.\n\n${JSON.stringify(unsigned)}`);
    assert.equal(out.agentName, null);
    assert.deepEqual(out.result, unsigned);
    assert.equal(out.empty, false);
  });

  it('reports pure prose as a shape violation, not as empty', () => {
    // "Said nothing" and "said something useless" are different failures and get
    // different messages: one means re-dispatch, the other means the contract is wrong.
    const out = extractAgentResult('The plan looks fine to me. No blocking issues.');
    assert.equal(out.result, null);
    assert.equal(out.empty, false);
  });

  it('reports an empty return as empty', () => {
    for (const value of ['', '   ', null, undefined]) {
      assert.equal(extractAgentResult(value).empty, true, `${JSON.stringify(value)} should be empty`);
    }
  });

  it('does not hang or throw on an unterminated brace', () => {
    // A truncated reply (the model ran out of tokens mid-object) must degrade, not
    // spin: the scanner has to notice the object never closes.
    const out = extractAgentResult('Here you go:\n\n{"agentName":"diagnose","bugScope":"back');
    assert.equal(out.result, null);
    assert.equal(out.empty, false);
  });
});
