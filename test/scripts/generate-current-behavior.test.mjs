// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/generate-current-behavior.mjs';

describe('generate-current-behavior main()', () => {
  it('writes CURRENT_BEHAVIOR.md to a temp path containing a "Verified Hook Events" section', async () => {
    const root = resolve(tmpdir(), `gen-behavior-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    mkdirSync(resolve(root, 'hooks'), { recursive: true });

    const registryPath = resolve(root, 'docs', 'capability-registry.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        capabilities: [
          {
            id: 'check-docs-drift',
            type: 'script',
            name: 'Check Docs Drift',
            description: 'CI lint step for docs drift.',
            invocationPath: 'scripts/check-docs-drift.mjs',
            invocation: 'agent-invoked',
          },
        ],
      }),
      'utf8'
    );

    const hooksPath = resolve(root, 'hooks', 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PostToolUse: [{ type: 'command', event: 'PostToolUse', command: 'scripts/x.mjs' }],
        },
      }),
      'utf8'
    );

    const outputPath = resolve(root, 'docs', 'CURRENT_BEHAVIOR.md');
    const configSchemaPath = resolve(root, 'docs', 'config-schema.json'); // absent → skipped
    const testSummaryPath = resolve(root, 'docs', '.test-summary.json'); // absent → skipped

    try {
      const code = await main([], {
        rootOverride: root,
        registryPath,
        hooksPath,
        configSchemaPath,
        testSummaryPath,
        outputPath,
      });
      assert.equal(code, 0);

      const content = readFileSync(outputPath, 'utf8');
      assert.ok(content.includes('### Verified Hook Events'), 'has Verified Hook Events section');
      assert.ok(content.includes('`PostToolUse`'), 'lists the registered hook event');
      assert.ok(content.includes('### Registered Scripts'), 'has Registered Scripts section');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
