// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  writePattern,
  approvePattern,
  listPendingPatterns,
  PATTERNS_DIR,
} from '../../../lib/workflow/pattern-author.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-pat-'));
}

/** @returns {import('../../../lib/types.mjs').Pattern} */
function makePattern(over = {}) {
  return {
    id: 'use-atomic-writes',
    title: 'Use atomic writes',
    body: '# Use atomic writes\n\nWrite to .tmp then rename.\n',
    filePath: '.devmate/patterns/use-atomic-writes.md',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** @returns {import('../../../lib/types.mjs').PatternApproval} */
function makeApproval(over = {}) {
  return {
    patternId: 'use-atomic-writes',
    approvedBy: 'approve pattern: use-atomic-writes',
    approvedAt: new Date().toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// writePattern
// ---------------------------------------------------------------------------

test('writePattern — happy path writes under .devmate/patterns/', async () => {
  const root = tmp();
  try {
    const result = await writePattern(makePattern(), [makeApproval()], { root });
    assert.equal(result.written, true);
    assert.ok(existsSync(resolve(root, PATTERNS_DIR, 'use-atomic-writes.md')));
    const body = readFileSync(resolve(root, makePattern().filePath), 'utf8');
    assert.match(body, /Use atomic writes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePattern — throws when path is outside .devmate/patterns/', async () => {
  const root = tmp();
  try {
    await assert.rejects(
      () => writePattern(makePattern({ filePath: 'src/evil.md' }), [makeApproval()], { root }),
      /must be under \.devmate\/patterns\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePattern — throws on path traversal escape', async () => {
  const root = tmp();
  try {
    await assert.rejects(
      () =>
        writePattern(
          makePattern({ filePath: '.devmate/patterns/../../escape.md' }),
          [makeApproval()],
          { root },
        ),
      /must be under \.devmate\/patterns\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writePattern — throws when no matching approval exists', async () => {
  const root = tmp();
  try {
    await assert.rejects(
      () => writePattern(makePattern(), [], { root }),
      /No approval found for pattern/,
    );
    assert.ok(!existsSync(resolve(root, makePattern().filePath)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// approvePattern
// ---------------------------------------------------------------------------

test('approvePattern — valid approval on existing pending file writes sidecar', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'use-atomic-writes.pending.json'), JSON.stringify(makePattern()), 'utf8');
    await approvePattern(makeApproval(), dir);
    const sidecar = join(dir, 'use-atomic-writes.approvals.json');
    assert.ok(existsSync(sidecar));
    const approvals = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].patternId, 'use-atomic-writes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approvePattern — throws when pending file is missing', async () => {
  const dir = tmp();
  try {
    await assert.rejects(() => approvePattern(makeApproval(), dir), /no pending pattern/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approvePattern — throws on wrong approvedBy prefix', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'use-atomic-writes.pending.json'), JSON.stringify(makePattern()), 'utf8');
    await assert.rejects(
      () => approvePattern(makeApproval({ approvedBy: 'ok do it' }), dir),
      /approvedBy must start with/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listPendingPatterns
// ---------------------------------------------------------------------------

test('listPendingPatterns — returns staged pattern ids', async () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pending.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'b.pending.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'a.approvals.json'), '[]', 'utf8');
    const ids = await listPendingPatterns(dir);
    assert.deepEqual(ids.sort(), ['a', 'b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listPendingPatterns — returns empty array for missing dir', async () => {
  const ids = await listPendingPatterns('/nonexistent/devmate-pending-xyz');
  assert.deepEqual(ids, []);
});
