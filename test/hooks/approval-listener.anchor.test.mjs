// @ts-check
/**
 * E10-02: the UserPromptSubmit hook emits the model-visible `<devmate-state>`
 * anchor block on EVERY prompt (matched or not), emits nothing on a fresh
 * session, and never throws on malformed state.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import {
  emitStateAnchor,
  handleUserPromptSubmit,
} from '../../hooks/approval-listener.mjs';
import {
  ANCHOR_OPEN_TAG,
  ANCHOR_CLOSE_TAG,
} from '../../lib/orchestrator/state-anchor.mjs';
import { flattenTransitions } from '../../lib/gate-transitions.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

const HOOK_PATH = resolve(import.meta.dirname ?? '.', '..', '..', 'hooks', 'approval-listener.mjs');

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: 'feat-142',
    lane: 'feature',
    workflowGate: 'spec-draft',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 3,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp repo root; optionally seed `.devmate/state/task.json` with the
 * given raw contents (a string is written verbatim so malformed JSON can be
 * seeded; an object is serialized).
 * @param {TaskState|string} [state]
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot(state) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-anchor-'));
  if (state !== undefined) {
    const stateDir = join(root, '.devmate', 'state');
    mkdirSync(stateDir, { recursive: true });
    const body = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
    writeFileSync(join(stateDir, 'task.json'), body, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A writable stream that collects everything written to it.
 * @returns {{ stream: NodeJS.WritableStream, output: () => string }}
 */
function collectingWritable() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, output: () => data };
}

/**
 * Run the hook CLI end-to-end: spawn `node hooks/approval-listener.mjs` with
 * the given stdin payload, exactly as the hooks.json registration does.
 * @param {Record<string, unknown>} payload
 * @param {string} cwd
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function spawnHook(payload, cwd) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('hook emits the anchor block on a non-approval prompt while a task is in-flight', async () => {
  const fx = makeRoot(makeState());
  try {
    const out = collectingWritable();
    const result = await handleUserPromptSubmit({
      prompt: 'what about auth?',
      root: fx.root,
      stdout: out.stream,
    });
    assert.equal(result.action, 'passthrough', 'non-matching prompt still passes through');
    const text = out.output();
    assert.ok(text.includes(ANCHOR_OPEN_TAG), 'anchor block opens');
    assert.ok(text.includes(ANCHOR_CLOSE_TAG), 'anchor block closes');
    assert.ok(text.includes('gate: spec-draft'), 'names the current gate');
    assert.ok(text.includes('lane: feature'), 'names the lane');
    const legal = flattenTransitions()['spec-draft'];
    assert.ok(
      text.includes(`legal next gates: ${legal.join(', ')}`),
      'names the legal next transitions from the unified table',
    );
  } finally {
    fx.cleanup();
  }
});

test('hook emits the anchor on a matched phrase too (independent of matching)', async () => {
  const fx = makeRoot(makeState());
  try {
    const out = collectingWritable();
    const result = await handleUserPromptSubmit({
      prompt: 'revise spec: tighten the error copy',
      root: fx.root,
      stdout: out.stream,
    });
    assert.equal(result.action, 'revision_requested');
    assert.ok(out.output().includes(ANCHOR_OPEN_TAG), 'anchor emitted before phrase handling');
  } finally {
    fx.cleanup();
  }
});

test('hook emits nothing on missing state (fresh session) and does not error', async () => {
  const fx = makeRoot();
  try {
    const out = collectingWritable();
    const result = await handleUserPromptSubmit({
      prompt: 'what about auth?',
      root: fx.root,
      stdout: out.stream,
    });
    assert.equal(result.action, 'passthrough');
    assert.ok(!out.output().includes(ANCHOR_OPEN_TAG), 'no anchor without task.json');
  } finally {
    fx.cleanup();
  }
});

test('hook never throws on malformed state', async () => {
  const malformedJson = makeRoot('{ this is not json');
  const invalidShape = makeRoot(
    JSON.stringify({ taskId: 't-1', lane: 'feature', workflowGate: 'bogus-gate' }),
  );
  try {
    for (const fx of [malformedJson, invalidShape]) {
      const out = collectingWritable();
      const result = await handleUserPromptSubmit({
        prompt: 'what about auth?',
        root: fx.root,
        stdout: out.stream,
      });
      assert.equal(result.action, 'passthrough', 'malformed state degrades to passthrough');
      assert.ok(!out.output().includes(ANCHOR_OPEN_TAG), 'no anchor from unreadable state');
    }
  } finally {
    malformedJson.cleanup();
    invalidShape.cleanup();
  }
});

test('emitStateAnchor never throws when the stream itself fails', () => {
  const fx = makeRoot(makeState());
  try {
    const broken = /** @type {NodeJS.WritableStream} */ (
      /** @type {unknown} */ ({
        write() {
          throw new Error('stream exploded');
        },
      })
    );
    assert.doesNotThrow(() => emitStateAnchor(fx.root, broken));
  } finally {
    fx.cleanup();
  }
});

test('CLI end-to-end: spawned hook prints the anchor for a non-approval prompt', () => {
  const fx = makeRoot(makeState());
  try {
    const run = spawnHook(
      {
        prompt: 'what about auth?',
        cwd: fx.root,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'anchor-e2e',
        timestamp: new Date().toISOString(),
      },
      fx.root,
    );
    assert.equal(run.status, 0, `exit 0 (stderr: ${run.stderr})`);
    assert.ok(run.stdout.includes(ANCHOR_OPEN_TAG), 'stdout carries the anchor block');
    assert.ok(run.stdout.includes('gate: spec-draft'));
  } finally {
    fx.cleanup();
  }
});

test('CLI end-to-end: fresh session emits no block and exits 0', () => {
  const fx = makeRoot();
  try {
    const run = spawnHook(
      { prompt: 'hello there', cwd: fx.root, hook_event_name: 'UserPromptSubmit' },
      fx.root,
    );
    assert.equal(run.status, 0, `exit 0 (stderr: ${run.stderr})`);
    assert.ok(!run.stdout.includes(ANCHOR_OPEN_TAG), 'no anchor without task state');
  } finally {
    fx.cleanup();
  }
});

test('CLI end-to-end: filters internally on hook_event_name', () => {
  const fx = makeRoot(makeState());
  try {
    const run = spawnHook(
      { prompt: 'what about auth?', cwd: fx.root, hook_event_name: 'PreToolUse' },
      fx.root,
    );
    assert.equal(run.status, 0);
    assert.ok(!run.stdout.includes(ANCHOR_OPEN_TAG), 'other events are no-ops');
  } finally {
    fx.cleanup();
  }
});

test('CLI end-to-end: malformed stdin JSON is ignored with exit 0', () => {
  const fx = makeRoot(makeState());
  try {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: fx.root,
      input: '{ not json',
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, 'malformed payload never blocks the prompt');
    assert.ok(!result.stdout.includes(ANCHOR_OPEN_TAG));
  } finally {
    fx.cleanup();
  }
});
