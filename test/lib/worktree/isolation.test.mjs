// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createIsolatedWorktree,
  teardownWorktree,
  extractDiff,
} from '../../../lib/worktree/isolation.mjs';

/**
 * Create a throwaway git repo with one commit and return its absolute path.
 * @returns {string}
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-wt-'));
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

/** @param {string} dir */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('isolation › creates worktree and branch in temp repo', async () => {
  const repo = makeRepo();
  const wtPath = resolve(repo, '..', `wt-${Date.now()}-create`);
  try {
    const handle = await createIsolatedWorktree({
      baseRef: 'main',
      branchName: 'devmate/throwaway-1',
      worktreePath: wtPath,
      repoRoot: repo,
    });
    assert.equal(handle.active, true);
    assert.equal(handle.branchName, 'devmate/throwaway-1');
    assert.ok(existsSync(wtPath), 'worktree directory exists');
    assert.ok(existsSync(join(wtPath, 'README.md')), 'base files checked out');
    const branches = execFileSync('git', ['branch', '--list', 'devmate/throwaway-1'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.match(branches, /devmate\/throwaway-1/);
    await teardownWorktree(handle);
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('isolation › teardown removes worktree directory', async () => {
  const repo = makeRepo();
  const wtPath = resolve(repo, '..', `wt-${Date.now()}-rm`);
  try {
    const handle = await createIsolatedWorktree({
      baseRef: 'main',
      branchName: 'devmate/throwaway-2',
      worktreePath: wtPath,
      repoRoot: repo,
    });
    assert.ok(existsSync(wtPath));
    await teardownWorktree(handle);
    assert.equal(existsSync(wtPath), false, 'worktree directory removed');
    assert.equal(handle.active, false);
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('isolation › teardown deletes branch', async () => {
  const repo = makeRepo();
  const wtPath = resolve(repo, '..', `wt-${Date.now()}-branch`);
  try {
    const handle = await createIsolatedWorktree({
      baseRef: 'main',
      branchName: 'devmate/throwaway-3',
      worktreePath: wtPath,
      repoRoot: repo,
    });
    await teardownWorktree(handle);
    const branches = execFileSync('git', ['branch', '--list', 'devmate/throwaway-3'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(branches.trim(), '', 'branch deleted');
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('isolation › teardown no-ops when handle.active=false', async () => {
  /** @type {import('../../../lib/types.mjs').WorktreeHandle} */
  const handle = {
    branchName: 'never',
    worktreePath: '/nonexistent/path',
    baseRef: 'main',
    createdAt: new Date().toISOString(),
    active: false,
    repoRoot: '/nonexistent',
  };
  // Should not throw despite bogus paths.
  await teardownWorktree(handle);
  assert.equal(handle.active, false);
});

test('isolation › createIsolatedWorktree cleans up on git failure', async () => {
  const repo = makeRepo();
  try {
    // Branch name 'main' already exists → `git worktree add -b main` fails.
    await assert.rejects(
      createIsolatedWorktree({
        baseRef: 'main',
        branchName: 'main',
        worktreePath: resolve(repo, '..', `wt-${Date.now()}-fail`),
        repoRoot: repo,
      })
    );
    // No stray worktrees should remain registered.
    const list = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    const lines = list.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'only the main worktree remains');
  } finally {
    cleanup(repo);
  }
});

test('extractDiff › returns filesChanged, insertions, deletions', async () => {
  const repo = makeRepo();
  const wtPath = resolve(repo, '..', `wt-${Date.now()}-diff`);
  try {
    const handle = await createIsolatedWorktree({
      baseRef: 'main',
      branchName: 'devmate/diff-1',
      worktreePath: wtPath,
      repoRoot: repo,
    });
    // Make a change + commit inside the worktree.
    writeFileSync(join(wtPath, 'new.txt'), 'a\nb\nc\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: wtPath });
    execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: wtPath });

    const diff = await extractDiff(handle);
    assert.equal(diff.filesChanged, 1);
    assert.equal(diff.insertions, 3);
    assert.equal(diff.deletions, 0);
    await teardownWorktree(handle);
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('extractDiff › saves artifact and caps diffText at 64KB', async () => {
  const repo = makeRepo();
  const wtPath = resolve(repo, '..', `wt-${Date.now()}-cap`);
  try {
    const handle = await createIsolatedWorktree({
      baseRef: 'main',
      branchName: 'devmate/diff-big',
      worktreePath: wtPath,
      repoRoot: repo,
    });
    // Write a large file (well over 64 KB) and commit it in the worktree.
    const big = 'x'.repeat(200 * 1024) + '\n';
    writeFileSync(join(wtPath, 'big.txt'), big, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: wtPath });
    execFileSync('git', ['commit', '-q', '-m', 'big'], { cwd: wtPath });

    const diff = await extractDiff(handle);
    assert.ok(existsSync(diff.artifactPath), 'artifact saved');
    assert.ok(diff.artifactPath.length > 0, 'artifact path always set');
    assert.ok(
      Buffer.byteLength(diff.diffText, 'utf8') <= 64 * 1024,
      'diffText capped at 64KB'
    );
    await teardownWorktree(handle);
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
    cleanup(repo);
  }
});
