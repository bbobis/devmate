// @ts-check
/**
 * #76 — the task.json split-brain regression.
 *
 * init-task-state used to write task.json to the cwd-relative STATE_PATH with
 * no root resolution, while the climbed readers (post-tool-use,
 * approval-listener) looked one level up. Run from the integrated terminal —
 * which opens at workspaceFolders[0], the workspace's own `.devmate/` folder in
 * the monoroot layout — the writer landed state at
 * `.devmate/.devmate/state/task.json`, the cwd-relative readers (gate-guard,
 * subagent guard) saw it, and the climbed readers reported the pre-task window
 * forever. Gates advanced on state the memory subsystem could not see, and the
 * user saw "Unable to resolve nonexistent file …/.devmate/state/task.json".
 *
 * The invariant: WHEREVER the CLI runs from inside a workspace, the writer and
 * every reader must converge on the same file.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT = join(__dirname, '..', '..', 'scripts', 'init-task-state.mjs');
const POST = join(__dirname, '..', '..', 'hooks', 'post-tool-use.mjs');

test(
  'init-task-state run from the .devmate folder writes where the climbed readers look',
  skipUnlessNode(24),
  () => {
    const root = mkdtempSync(join(tmpdir(), 'its-splitbrain-'));
    const devmateDir = join(root, '.devmate');
    mkdirSync(join(devmateDir, 'state'), { recursive: true });
    try {
      // 1) The writer, run exactly as the orchestrator does — from the
      //    integrated terminal whose cwd is the .devmate folder.
      const init = spawnSync(
        'node',
        [INIT, '--taskId', 'feat-sb-1', '--lane', 'feature'],
        { cwd: devmateDir, encoding: 'utf8', timeout: 10000 },
      );
      assert.equal(init.status, 0, `init-task-state failed: ${init.stderr}`);

      const canonical = join(root, '.devmate', 'state', 'task.json');
      const doubled = join(devmateDir, '.devmate', 'state', 'task.json');
      assert.ok(existsSync(canonical), 'task.json must land at the workspace root');
      assert.equal(existsSync(doubled), false, 'and never at the doubled path');
      assert.equal(JSON.parse(readFileSync(canonical, 'utf8')).taskId, 'feat-sb-1');

      // 2) A climbed reader in the same workspace, same cwd, must SEE that
      //    task — before #76 it reported the pre-task window forever.
      const post = spawnSync('node', [POST], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'replace_string_in_file',
          tool_input: { filePath: join(root, 'lib', 'x.mjs') },
          cwd: devmateDir,
        }),
        cwd: devmateDir,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(post.status, 0);
      assert.doesNotMatch(
        post.stderr ?? '',
        /pre_task/,
        'the reader must find the state the writer just wrote — no split-brain',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
