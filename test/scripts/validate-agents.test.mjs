// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAgentFrontmatter } from '../../lib/agent-validator.mjs';
import { main } from '../../scripts/validate-agents.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `validate-agents-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('validate-agents.mjs main()', () => {
  it('parses agents frontmatter arrays in inline and block forms', () => {
    const inline = parseAgentFrontmatter(`---
name: orchestrator
tools: ['agent']
agents: ['fullstack', 'security']
---
`);
    assert.deepEqual(inline.agents, ['fullstack', 'security']);

    const block = parseAgentFrontmatter(`---
name: orchestrator
tools:
  - agent
agents:
  - fullstack
  - security
---
`);
    assert.deepEqual(block.agents, ['fullstack', 'security']);
  });

  it('returns 0 for a directory of valid agent fixtures', async () => {
    const dir = join(fixtureDir, 'valid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.agent.md'), `---
name: ok-agent
tools: ['edit', 'execute', 'search/codebase']
skills: ['tdd-debug']
model: Claude Sonnet 5 (copilot)
---

# OK Agent

This agent analyzes requirements and produces structured output.
`);
    const code = await main(['--dir', dir]);
    assert.equal(code, 0);
  });

  it('returns 1 and prints the violating file and claim for a directory with one mismatched agent', async () => {
    const dir = join(fixtureDir, 'invalid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.agent.md'), `---
name: bad-agent
tools: ['search/codebase']
model: Claude Sonnet 5 (copilot)
---

# Bad Agent

This agent writes output to disk without the edit tool.
`);
    // Capture stderr to verify it contains the file name
    const stderrChunks = /** @type {Buffer[]} */ ([]);
    const origWrite = process.stderr.write.bind(process.stderr);
    /** @param {any} chunk @param {any} [enc] @param {any} [cb] @returns {boolean} */
    const patchedWrite = (chunk, enc, cb) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk, enc, cb);
    };
    process.stderr.write = patchedWrite;
    let code;
    try {
      code = await main(['--dir', dir]);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(code, 1);
    const stderrOutput = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(stderrOutput.includes('bad.agent.md'), `expected 'bad.agent.md' in stderr: ${stderrOutput}`);
  });

  it('returns 0 when all agents referenced in frontmatter exist', async () => {
    const dir = join(fixtureDir, 'crossref-valid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orchestrator.agent.md'), `---
name: orchestrator
tools: ['agent']
agents: ['fullstack']
model: Claude Sonnet 5 (copilot)
---

# Orchestrator

Read-only coordination only.
`);
    writeFileSync(join(dir, 'fullstack.agent.md'), `---
name: fullstack
tools: ['search/codebase']
model: Claude Sonnet 5 (copilot)
---

# Fullstack

Read-only placeholder.
`);

    const code = await main(['--dir', dir]);
    assert.equal(code, 0);
  });

  it('returns 1 when agents frontmatter references a missing agent file', async () => {
    const dir = join(fixtureDir, 'crossref-invalid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orchestrator.agent.md'), `---
name: orchestrator
tools: ['agent']
agents: ['frontend-tester']
model: Claude Sonnet 5 (copilot)
---

# Orchestrator

Read-only coordination only.
`);

    const stderrChunks = /** @type {Buffer[]} */ ([]);
    const origWrite = process.stderr.write.bind(process.stderr);
    /** @param {any} chunk @param {any} [enc] @param {any} [cb] @returns {boolean} */
    const patchedWrite = (chunk, enc, cb) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk, enc, cb);
    };
    process.stderr.write = patchedWrite;
    let code;
    try {
      code = await main(['--dir', dir]);
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(code, 1);
    const stderrOutput = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(stderrOutput.includes('orchestrator.agent.md'), `expected orchestrator file in stderr: ${stderrOutput}`);
    assert.ok(stderrOutput.includes('frontend-tester'), `expected missing agent name in stderr: ${stderrOutput}`);
  });
});
