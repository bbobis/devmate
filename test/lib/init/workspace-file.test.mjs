// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  findCodeWorkspaceFile,
  parseWorkspaceFolders,
  matchFolderForCwd,
} from '../../../lib/init/workspace-file.mjs';

/** @returns {{ dir: string, cleanup: () => void }} */
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-file-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// findCodeWorkspaceFile
// ---------------------------------------------------------------------------

test('findCodeWorkspaceFile — finds *.code-workspace in start dir', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    writeFileSync(join(dir, 'my.code-workspace'), '{}');
    const result = await findCodeWorkspaceFile(dir);
    assert.ok(result !== null);
    assert.ok(/** @type {string} */ (result).endsWith('.code-workspace'));
  } finally {
    cleanup();
  }
});

test('findCodeWorkspaceFile — finds *.code-workspace one level up', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    writeFileSync(join(dir, 'root.code-workspace'), '{}');
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    const result = await findCodeWorkspaceFile(sub);
    assert.ok(result !== null);
    assert.ok(/** @type {string} */ (result).endsWith('root.code-workspace'));
  } finally {
    cleanup();
  }
});

test('findCodeWorkspaceFile — returns null when no workspace file exists', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const sub = join(dir, 'deep', 'path');
    mkdirSync(sub, { recursive: true });
    const result = await findCodeWorkspaceFile(sub);
    if (result !== null) {
      assert.ok(typeof result === 'string');
      assert.ok(result.endsWith('.code-workspace'));
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// parseWorkspaceFolders
// ---------------------------------------------------------------------------

test('parseWorkspaceFolders — resolves relative folder paths against workspace file location', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const wsPath = join(dir, 'test.code-workspace');
    writeFileSync(wsPath, JSON.stringify({ folders: [{ path: './repo-a' }, { path: './repo-b' }] }));
    const folders = await parseWorkspaceFolders(wsPath);
    assert.equal(folders.length, 2);
    assert.equal(folders[0].path, join(dir, 'repo-a'));
    assert.equal(folders[1].path, join(dir, 'repo-b'));
  } finally {
    cleanup();
  }
});

test('parseWorkspaceFolders — handles absolute folder paths', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const absRepo = join(dir, 'abs-repo');
    const wsPath = join(dir, 'abs.code-workspace');
    writeFileSync(wsPath, JSON.stringify({ folders: [{ path: absRepo }] }));
    const folders = await parseWorkspaceFolders(wsPath);
    assert.equal(folders.length, 1);
    assert.equal(folders[0].path, absRepo);
  } finally {
    cleanup();
  }
});

test('parseWorkspaceFolders — skips entries with uri key (remote folders)', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const wsPath = join(dir, 'remote.code-workspace');
    writeFileSync(
      wsPath,
      JSON.stringify({
        folders: [
          { uri: 'vscode-remote://ssh-remote+host/home/user/repo', name: 'remote' },
          { path: './local-repo' },
        ],
      }),
    );
    const folders = await parseWorkspaceFolders(wsPath);
    assert.equal(folders.length, 1);
    assert.equal(folders[0].path, join(dir, 'local-repo'));
  } finally {
    cleanup();
  }
});

test('parseWorkspaceFolders — returns [] on malformed JSON', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const wsPath = join(dir, 'bad.code-workspace');
    writeFileSync(wsPath, 'NOT VALID JSON {{{{');
    const folders = await parseWorkspaceFolders(wsPath);
    assert.deepEqual(folders, []);
  } finally {
    cleanup();
  }
});

test('parseWorkspaceFolders — returns [] on missing file', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const folders = await parseWorkspaceFolders(join(dir, 'nonexistent.code-workspace'));
    assert.deepEqual(folders, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// matchFolderForCwd
// ---------------------------------------------------------------------------

test('matchFolderForCwd — returns folder path when cwd is inside folder', () => {
  /** @type {import('../../../lib/init/workspace-file.mjs').WorkspaceFolder[]} */
  const folders = [{ path: '/workspace/repo-a' }, { path: '/workspace/repo-b' }];
  const result = matchFolderForCwd(folders, '/workspace/repo-a/src/deep');
  assert.equal(result, resolve('/workspace/repo-a'));
});

test('matchFolderForCwd — returns folder path when cwd equals folder exactly', () => {
  /** @type {import('../../../lib/init/workspace-file.mjs').WorkspaceFolder[]} */
  const folders = [{ path: '/workspace/repo-a' }];
  const result = matchFolderForCwd(folders, '/workspace/repo-a');
  assert.equal(result, resolve('/workspace/repo-a'));
});

test('matchFolderForCwd — returns null when cwd is not inside any folder', () => {
  /** @type {import('../../../lib/init/workspace-file.mjs').WorkspaceFolder[]} */
  const folders = [{ path: '/workspace/repo-a' }, { path: '/workspace/repo-b' }];
  const result = matchFolderForCwd(folders, '/workspace');
  assert.equal(result, null);
});

test('matchFolderForCwd — returns null for empty folder list', () => {
  const result = matchFolderForCwd([], '/workspace/repo-a/src');
  assert.equal(result, null);
});
