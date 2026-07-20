// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  sessionMarkerPath,
  markDevmateSession,
  isDevmateSession,
  clearDevmateSession,
} from '../../../lib/hooks/session-marker.mjs';

/** A fresh, host-shaped session id per assertion so tests never collide. */
const sid = () => randomUUID();

test('unmarked session is not a devmate session (the never-block default)', () => {
  assert.equal(isDevmateSession(sid()), false);
});

test('mark → isDevmateSession true → clear → false', () => {
  const s = sid();
  assert.equal(isDevmateSession(s), false);
  markDevmateSession(s, 'router');
  try {
    assert.equal(isDevmateSession(s), true);
  } finally {
    clearDevmateSession(s);
  }
  assert.equal(isDevmateSession(s), false);
});

test('marker lives in the OS temp dir, never the workspace', () => {
  const p = sessionMarkerPath(sid());
  assert.notEqual(p, null);
  assert.ok(/** @type {string} */ (p).startsWith(tmpdir()), `marker escaped temp: ${p}`);
});

test('fail-open: blank / non-string session ids are never devmate and never throw', () => {
  for (const bad of ['', '   ', '---', null, undefined, 42, {}]) {
    assert.equal(sessionMarkerPath(/** @type {any} */ (bad)), null);
    assert.equal(isDevmateSession(/** @type {any} */ (bad)), false);
    // mark/clear on an unusable id are silent no-ops, not throws.
    assert.doesNotThrow(() => markDevmateSession(/** @type {any} */ (bad)));
    assert.doesNotThrow(() => clearDevmateSession(/** @type {any} */ (bad)));
  }
});

test('clearing an already-absent marker is a silent no-op', () => {
  assert.doesNotThrow(() => clearDevmateSession(sid()));
});

test('TTL: a marker older than 7 days reads as not-devmate (abandoned thread ages out)', () => {
  const s = sid();
  markDevmateSession(s, 'router');
  try {
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    assert.equal(isDevmateSession(s, Date.now() + EIGHT_DAYS), false, 'expired marker must not enforce');
    assert.equal(isDevmateSession(s), true, 'fresh marker still valid at the real clock');
  } finally {
    clearDevmateSession(s);
  }
});

test('TTL: re-marking refreshes the marker (an active workflow never ages out)', () => {
  const s = sid();
  markDevmateSession(s, 'router');
  try {
    // Re-mark (as every devmate SubagentStart does) and confirm still valid
    // "six days later" relative to the refresh.
    markDevmateSession(s, 'fullstack');
    const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;
    assert.equal(isDevmateSession(s, Date.now() + SIX_DAYS), true);
  } finally {
    clearDevmateSession(s);
  }
});

test('two sessions are independent', () => {
  const a = sid();
  const b = sid();
  markDevmateSession(a, 'fullstack');
  try {
    assert.equal(isDevmateSession(a), true);
    assert.equal(isDevmateSession(b), false, 'marking one session must not mark another');
  } finally {
    clearDevmateSession(a);
  }
});
