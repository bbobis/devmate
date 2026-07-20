// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findWriteTaskStateCallers,
  computeStateWriterViolations,
} from '../../lib/state-writer-lint.mjs';

test('findWriteTaskStateCallers — flags a real call, ignores imports and comments', () => {
  const files = [
    { path: 'a.mjs', text: 'import { writeTaskState } from "./x.mjs";\nawait writeTaskState(state, p);' },
    { path: 'b.mjs', text: 'import { writeTaskState } from "./x.mjs";\n// never actually calls it' },
    { path: 'c.mjs', text: '// documents writeTaskState( in prose only\nconst re = /writeTaskState/;' },
    { path: 'd.mjs', text: '/* block: writeTaskState( in a comment */\nawait mutateTaskStateUnderLock(fn, p);' },
    { path: 'e.mjs', text: 'writeTaskState  (state, p);' },
  ];
  const callers = findWriteTaskStateCallers(files);
  assert.deepEqual(callers, ['a.mjs', 'e.mjs'], 'only genuine call sites (whitespace tolerated), not imports/comments');
});

test('findWriteTaskStateCallers — a capitalized identifier is not a match', () => {
  const files = [{ path: 'f.mjs', text: 'export function findWriteTaskStateCallers(x) { return x; }' }];
  assert.deepEqual(findWriteTaskStateCallers(files), [], 'findWriteTaskStateCallers is not writeTaskState(');
});

test('findWriteTaskStateCallers — a renamed import cannot dodge the guard', () => {
  const files = [
    { path: 'sneaky.mjs', text: 'import { writeTaskState as w } from "./x.mjs";\nawait w(state, p);' },
  ];
  assert.deepEqual(findWriteTaskStateCallers(files), ['sneaky.mjs'], 'aliased import of the blind writer is flagged');
});

test('computeStateWriterViolations — unlisted callers are violations', () => {
  const { unlisted, stale } = computeStateWriterViolations(
    ['lib/task-state.mjs', 'hooks/new-writer.mjs'],
    { 'lib/task-state.mjs': 'home' },
  );
  assert.deepEqual(unlisted, ['hooks/new-writer.mjs']);
  assert.deepEqual(stale, []);
});

test('computeStateWriterViolations — an allowlist entry that no longer calls it is stale', () => {
  const { unlisted, stale } = computeStateWriterViolations(
    ['lib/task-state.mjs'],
    { 'lib/task-state.mjs': 'home', 'lib/migrated.mjs': 'was a writer, now migrated' },
  );
  assert.deepEqual(unlisted, []);
  assert.deepEqual(stale, ['lib/migrated.mjs'], 'migrated writer must be pruned from the allowlist');
});

test('computeStateWriterViolations — fully covered allowlist is clean', () => {
  const { unlisted, stale } = computeStateWriterViolations(
    ['lib/task-state.mjs', 'lib/gatectl.mjs'],
    { 'lib/task-state.mjs': 'home', 'lib/gatectl.mjs': 'guarded transition' },
  );
  assert.deepEqual({ unlisted, stale }, { unlisted: [], stale: [] });
});
