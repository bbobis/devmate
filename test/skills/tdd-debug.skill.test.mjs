// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseAgentFrontmatter,
  checkTddSkillRule,
} from '../../lib/agent-validator.mjs';

const SKILL_PATH = resolve('skills/tdd-debug/SKILL.md');
const PROTOCOL_PATH = resolve('skills/tdd-debug/refs/protocol.md');

describe('tdd-debug.skill', () => {
  it('SKILL.md exists at skills/tdd-debug/SKILL.md', () => {
    assert.ok(existsSync(SKILL_PATH), `expected SKILL.md at ${SKILL_PATH}`);
  });

  it('SKILL.md links to the full protocol reference', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    assert.match(content, /refs\/protocol\.md/);
  });

  it('refs/protocol.md contains RED section', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /### Step 1 — RED/);
  });

  it('refs/protocol.md contains GREEN section', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /### Step 2 — GREEN/);
  });

  it('refs/protocol.md contains REFACTOR section', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /### Step 3 — REFACTOR/);
  });

  it('refs/protocol.md contains all 5 Hard Rules', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /## Hard Rules/);
    assert.match(content, /NEVER write implementation before a failing test exists for that AC/);
    assert.match(content, /NEVER mark an AC complete without a passing test/);
    assert.match(content, /NEVER skip RED phase/);
    assert.match(content, /NEVER run the full test suite as substitute for the targeted test in RED phase/);
    assert.match(content, /If stuck on RED for > 3 attempts/);
  });

  it('refs/protocol.md contains Unexpected RED section', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /## Unexpected RED \(regression\)/);
  });

  it('refs/protocol.md contains Unexpected GREEN section', () => {
    const content = readFileSync(PROTOCOL_PATH, 'utf8');
    assert.match(content, /## Unexpected GREEN \(trivially passes\)/);
  });
});

describe('validate-agents.checkTddSkillRule', () => {
  it('write-capable agent without tdd-debug fails checkTddSkillRule', () => {
    const fm = parseAgentFrontmatter(`---
name: bad-writer
tools: ['edit', 'execute']
skills: ['other-skill']
---

# Bad Writer
`);
    const r = checkTddSkillRule(fm);
    assert.equal(r.passed, false);
    assert.equal(r.agentName, 'bad-writer');
    assert.match(r.violation ?? '', /tdd-debug/);
  });

  it('write-capable agent with tdd-debug passes checkTddSkillRule', () => {
    const fm = parseAgentFrontmatter(`---
name: good-writer
tools: ['edit', 'execute']
skills: ['tdd-debug', 'other-skill']
---

# Good Writer
`);
    const r = checkTddSkillRule(fm);
    assert.equal(r.passed, true);
    assert.equal(r.agentName, 'good-writer');
  });

  it('read-only agent without tdd-debug passes checkTddSkillRule (rule only applies to write-capable)', () => {
    const fm = parseAgentFrontmatter(`---
name: read-only-agent
tools: ['search/codebase']
---

# Read-Only Agent
`);
    const r = checkTddSkillRule(fm);
    assert.equal(r.passed, true);
    assert.equal(r.agentName, 'read-only-agent');
  });
});
