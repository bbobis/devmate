// @ts-check

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createTechDesignArtifact,
  persistTechDesignArtifact,
  readDesignArtifact,
  writeDesignArtifact,
} from '../lib/workflow/agents/tech-design.mjs';

/**
 * @returns {string}
 */
function makeTmpRepo() {
  return mkdtempSync(join(tmpdir(), 'devmate-tech-design-'));
}

describe('tech-design artifact write/read helpers', () => {
  test('unit / writeDesignArtifact rejects malformed artifact before write', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-UNIT-1';
      const sessionDir = join(repoRoot, '.devmate', 'session', taskId);

      await assert.rejects(
        () =>
          writeDesignArtifact(
            taskId,
            /** @type {import('../lib/workflow/agents/tech-design.mjs').TechDesignArtifact} */ ({
              dataModel: {},
              apiContracts: [],
              layerBoundaries: ['API -> service'],
              assumptions: ['[UNVERIFIED] assumption'],
              risks: ['[UNVERIFIED] risk'],
              unverified: ['[UNVERIFIED] assumption', '[UNVERIFIED] risk'],
            }),
            { repoRoot },
          ),
        (err) => {
          assert.equal(err instanceof Error, true);
          const message = /** @type {Error} */ (err).message;
          assert.equal(message.includes('at least one of dataModel or apiContracts'), true);
          return true;
        },
      );

      assert.equal(existsSync(sessionDir), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('unit / writeDesignArtifact rejects empty taskId', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const artifact = createTechDesignArtifact({
        apiContracts: [{ name: 'GetOrder', method: 'GET', path: '/orders/:id', purpose: 'Fetch order' }],
      });

      await assert.rejects(
        () => writeDesignArtifact('', artifact, { repoRoot }),
        (err) => {
          assert.equal(err instanceof TypeError, true);
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('unit / readDesignArtifact throws descriptive error when file is missing', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-MISSING-1';
      const expectedPath = join(repoRoot, '.devmate', 'session', taskId, 'design.json');

      await assert.rejects(
        () => readDesignArtifact(taskId, { repoRoot }),
        (err) => {
          assert.equal(err instanceof Error, true);
          const message = /** @type {Error} */ (err).message;
          assert.equal(message.includes('design artifact not found at'), true);
          assert.equal(message.includes(expectedPath), true);
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('unit / readDesignArtifact rejects empty taskId', async () => {
    const repoRoot = makeTmpRepo();
    try {
      await assert.rejects(
        () => readDesignArtifact('   ', { repoRoot }),
        (err) => {
          assert.equal(err instanceof TypeError, true);
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('integration / write then read round-trips full artifact', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-INTEG-ROUNDTRIP';
      const artifact = createTechDesignArtifact({
        dataModel: {
          aggregate: 'Order',
          entities: ['Order', 'OrderLine'],
          relationships: [{ from: 'Order', to: 'OrderLine', type: 'one-to-many' }],
        },
        apiContracts: [
          {
            name: 'CreateOrder',
            method: 'POST',
            path: '/api/orders',
            purpose: 'Create a new order',
          },
        ],
        layerBoundaries: ['UI -> API via HTTP', 'Domain -> persistence via repository'],
        assumptions: ['token issuer remains backward compatible'],
        risks: ['cache invalidation strategy unresolved'],
      });

      const writeResult = await writeDesignArtifact(taskId, artifact, { repoRoot });
      const readResult = await readDesignArtifact(taskId, { repoRoot });

      assert.equal(writeResult.path, join(repoRoot, '.devmate', 'session', taskId, 'design.json'));
      assert.deepEqual(readResult, artifact);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('integration / writeDesignArtifact creates session subdir when absent', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-CREATE-DIR';
      const outputPath = join(repoRoot, '.devmate', 'session', taskId, 'design.json');
      assert.equal(existsSync(outputPath), false);

      const artifact = createTechDesignArtifact({
        apiContracts: [{ name: 'GetStatus', method: 'GET', path: '/api/status', purpose: 'Health status' }],
      });

      await writeDesignArtifact(taskId, artifact, { repoRoot });

      assert.equal(existsSync(outputPath), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('integration / persistTechDesignArtifact writes design.json for agent flow', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PERSIST';
      const persisted = await persistTechDesignArtifact(
        taskId,
        {
          dataModel: { aggregate: 'Invoice' },
          apiContracts: [
            { name: 'GetInvoice', method: 'GET', path: '/api/invoices/:id', purpose: 'Fetch invoice detail' },
          ],
          layerBoundaries: ['API -> service'],
          assumptions: ['upstream id format remains stable'],
          risks: ['partial failures in downstream billing system'],
        },
        { repoRoot },
      );

      const expectedPath = join(repoRoot, '.devmate', 'session', taskId, 'design.json');
      assert.equal(persisted.path, expectedPath);
      assert.equal(existsSync(expectedPath), true);

      const onDisk = JSON.parse(readFileSync(expectedPath, 'utf8'));
      assert.deepEqual(onDisk, persisted.artifact);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
