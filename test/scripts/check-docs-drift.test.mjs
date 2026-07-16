// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-docs-drift.mjs';

/**
 * Build a temp docs set: a hooks manifest plus one markdown file.
 * @param {string} markdown  Content of the docs file.
 * @returns {{ root: string, hooksPath: string, configSchemaPath: string, docFile: string, patternsPath: string, ciPath: string }}
 */
function makeDocsSet(markdown) {
  const root = resolve(tmpdir(), `check-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(root, 'hooks'), { recursive: true });
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  const hooksPath = resolve(root, 'hooks', 'hooks.json');
  writeFileSync(
    hooksPath,
    JSON.stringify({
      schemaVersion: 1,
      hooks: {
        PostToolUse: [{ type: 'command', event: 'PostToolUse', command: 'scripts/x.mjs' }],
        SessionStart: [{ type: 'command', event: 'SessionStart', command: 'scripts/y.mjs' }],
        Stop: [{ type: 'command', event: 'Stop', command: 'scripts/z.mjs' }],
      },
    }),
    'utf8'
  );
  const docFile = resolve(root, 'docs', 'claims.md');
  writeFileSync(docFile, markdown, 'utf8');
  // config schema path that does not exist → skipped.
  const configSchemaPath = resolve(root, 'docs', 'config-schema.json');
  // Nonexistent patterns/ci paths → the E9-30 enforcement pass skips; these
  // fixtures exercise hook-event drift only.
  const patternsPath = resolve(root, 'docs', 'PATTERNS.md');
  const ciPath = resolve(root, 'ci.yml');
  return { root, hooksPath, configSchemaPath, docFile, patternsPath, ciPath };
}

describe('check-docs-drift main()', () => {
  it('returns 0 for a fixture docs set with no drift', async () => {
    const { root, hooksPath, configSchemaPath, docFile, patternsPath, ciPath } = makeDocsSet(
      '# Hooks\n\nThe `PostToolUse` and `SessionStart` hooks are registered.\n'
    );
    try {
      const code = await main([], { hooksPath, configSchemaPath, docsFiles: [docFile], patternsPath, ciPath });
      assert.equal(code, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns 1 and prints the violating claim and file/line for a stale event name', async () => {
    // `PreToolCall` is a misspelling — not an official event, not registered.
    const { root, hooksPath, configSchemaPath, docFile, patternsPath, ciPath } = makeDocsSet(
      '# Hooks\n\nThe `PreToolCall` hook runs before tools.\n'
    );

    const messages = /** @type {string[]} */ ([]);
    const originalWrite = process.stderr.write.bind(process.stderr);
    // @ts-ignore — temporary monkey-patch to capture stderr.
    process.stderr.write = (/** @type {string} */ msg) => { messages.push(msg); return true; };

    let code;
    try {
      code = await main([], { hooksPath, configSchemaPath, docsFiles: [docFile], patternsPath, ciPath });
    } finally {
      // @ts-ignore — restore original.
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }

    assert.equal(code, 1);
    const combined = messages.join('');
    assert.ok(combined.includes('PreToolCall'), 'output should name the violating claim');
    assert.ok(combined.includes(docFile), 'output should name the file');
    // The claim is on line 3 of the fixture.
    assert.ok(combined.includes('| 3 |') || combined.includes(' 3 '), 'output should include the line number');
  });
});
