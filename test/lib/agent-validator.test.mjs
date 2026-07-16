// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseAgentFrontmatter,
  extractBodyClaims,
  validateAgent,
} from '../../lib/agent-validator.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `agent-validator-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('parseAgentFrontmatter', () => {
  it('correctly parses tools array from a valid YAML frontmatter block', () => {
    const content = `---
name: test-agent
tools: ['edit', 'execute', 'search/codebase']
---

# Test Agent
`;
    const result = parseAgentFrontmatter(content);
    assert.deepEqual(result.tools, ['edit', 'execute', 'search/codebase']);
  });

  it('returns an empty object (with empty tools) when no frontmatter block is present', () => {
    const content = '# Agent without frontmatter\n\nSome body text.\n';
    const result = parseAgentFrontmatter(content);
    assert.deepEqual(result.tools, []);
    assert.equal(result.outputScope, undefined);
  });

  it('handles a frontmatter block with no tools key', () => {
    const content = `---
name: no-tools-agent
description: An agent with no tools declared.
---

# No Tools Agent
`;
    const result = parseAgentFrontmatter(content);
    assert.deepEqual(result.tools, []);
  });
});

describe('extractBodyClaims', () => {
  it('detects a writes-files claim from a fixture body containing "writes the output to"', () => {
    const content = `---
name: writer
tools: []
---

# Writer

This agent writes the output to disk.
`;
    const claims = extractBodyClaims(content);
    const writesClaim = claims.find((c) => c.type === 'writes-files');
    assert.ok(writesClaim, 'expected a writes-files claim');
    assert.ok(writesClaim.line > 0);
  });

  it('detects a runs-checks claim from a fixture body containing "runs linting"', () => {
    const content = `---
name: checker
tools: []
---

# Checker

This agent runs linting on the codebase.
`;
    const claims = extractBodyClaims(content);
    const runsClaim = claims.find((c) => c.type === 'runs-checks');
    assert.ok(runsClaim, 'expected a runs-checks claim');
  });

  it('returns no claims from a body with no recognized phrases', () => {
    const content = `---
name: readonly
tools: ['search/codebase']
---

# Read-Only Agent

This agent analyzes code and produces a report.
`;
    const claims = extractBodyClaims(content);
    assert.equal(claims.length, 0);
  });
});

describe('validateAgent', () => {
  it('returns {ok:true} for a fixture agent with matching frontmatter and body', async () => {
    const p = join(fixtureDir, 'valid.agent.md');
    writeFileSync(p, `---
name: valid-agent
tools: ['edit', 'execute']
skills: ['tdd-debug']
---

# Valid Agent

This agent writes files and runs checks.
`);
    const result = await validateAgent(p);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it('returns a violation with requiredTool: "edit" for a fixture agent claiming writes but lacking edit', async () => {
    const p = join(fixtureDir, 'no-edit.agent.md');
    writeFileSync(p, `---
name: no-edit
tools: ['search/codebase']
---

# No Edit Agent

This agent writes the output to a file.
`);
    const result = await validateAgent(p);
    assert.equal(result.ok, false);
    const editViolation = result.violations.find((v) => v.requiredTool === 'edit');
    assert.ok(editViolation, 'expected a violation with requiredTool edit');
  });

  it('returns a violation with requiredTool: "execute" for a fixture agent claiming checks but lacking execute', async () => {
    const p = join(fixtureDir, 'no-execute.agent.md');
    writeFileSync(p, `---
name: no-execute
tools: ['search/codebase']
---

# No Execute Agent

This agent runs linting on every commit.
`);
    const result = await validateAgent(p);
    assert.equal(result.ok, false);
    const execViolation = result.violations.find((v) => v.requiredTool === 'execute');
    assert.ok(execViolation, 'expected a violation with requiredTool execute');
  });
});
