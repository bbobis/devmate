// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentFrontmatter,
  extractBodyClaims,
  validateAgent,
} from '../../lib/agent-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, '../../agents/rubber-duck.agent.md');

describe('agents/rubber-duck.agent.md', () => {
  it('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  it('frontmatter has no write- or execute-class tools (read-only contract)', () => {
    const fm = parseAgentFrontmatter(readFileSync(AGENT_PATH, 'utf8'));
    const forbidden = ['edit', 'edit/file', 'create/file', 'execute', 'run/terminal'];
    for (const t of forbidden) {
      assert.ok(
        !fm.tools.includes(t),
        `rubber-duck must not declare '${t}'; declared tools: ${JSON.stringify(fm.tools)}`,
      );
    }
  });

  it('frontmatter declares only read-only tools (subset of allowed list)', () => {
    const fm = parseAgentFrontmatter(readFileSync(AGENT_PATH, 'utf8'));
    const allowed = new Set(['search/codebase', 'search/usages', 'read', 'read/problems']);
    for (const t of fm.tools) {
      assert.ok(allowed.has(t), `unexpected tool '${t}' in rubber-duck frontmatter`);
    }
    assert.ok(fm.tools.length > 0, 'rubber-duck must declare at least one read-only tool');
  });

  it('body contains no writes-files or runs-checks claims', () => {
    const claims = extractBodyClaims(readFileSync(AGENT_PATH, 'utf8'));
    const offending = claims.filter(
      (c) => c.type === 'writes-files' || c.type === 'runs-checks',
    );
    assert.deepEqual(
      offending,
      [],
      `rubber-duck body must stay read-only; found claims: ${JSON.stringify(offending)}`,
    );
  });

  it('body documents both grill (pre-plan) and critique (post-plan) modes', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.match(body, /##\s+Mode 1:\s+Grill/i, 'grill mode section missing');
    assert.match(body, /##\s+Mode 2:\s+Critique/i, 'critique mode section missing');
  });

  it('body declares the critique verdict contract (APPROVE_PLAN | REQUEST_REVISION)', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.match(body, /APPROVE_PLAN/);
    assert.match(body, /REQUEST_REVISION/);
  });

  it('body declares typed GrillResult and CritiqueResult output contracts', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.ok(body.includes('GrillResult'), 'body must mention GrillResult typed output');
    assert.ok(body.includes('CritiqueResult'), 'body must mention CritiqueResult typed output');
  });

  it('body references unverifiedItems hunting rule', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.ok(body.includes('unverifiedItems'), 'body must reference the unverifiedItems field');
    assert.ok(body.includes('[UNVERIFIED]'), 'body must reference [UNVERIFIED] tagging');
  });

  it('body declares two-revision limit rule with iterationNumber coercion', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.ok(body.includes('iterationNumber'), 'body must reference iterationNumber for revision tracking');
    assert.ok(body.includes('backwardsCompatRisks'), 'body must name backwardsCompatRisks as the fold target');
  });
});
