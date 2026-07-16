// @ts-check
// #100 — the published contract (docs/devmate-config.schema.json) must declare
// the session-artifact protection keys #93 added, not just the hand validator.
// A key whose whole job is to protect the gate is a bad place for a silent typo:
// absent from the schema, a consumer gets no editor validation and the producer
// (monoroot) has no basis to emit the keys at all.
//
// Neither repo runs a JSON-Schema engine at runtime (devmate has zero runtime
// deps), so this suite drives the fixtures corpus through a checker for exactly
// the subset the two subschemas use (type / items / minLength / pattern /
// required / properties / additionalProperties) and asserts the schema reaches
// the same verdict the hand validator does on every fixture carrying either key.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDevmateConfig } from '../../../lib/config/devmate-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'config-contract');

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {string} abs
 * @returns {JsonObject}
 */
function readJson(abs) {
  return /** @type {JsonObject} */ (JSON.parse(readFileSync(abs, 'utf8')));
}

const schema = readJson(join(ROOT, 'docs', 'devmate-config.schema.json'));
const properties = /** @type {JsonObject} */ (schema['properties']);

/**
 * Check a value against the JSON-Schema subset these two subschemas use. Any
 * keyword outside that subset is a test bug, not a silent pass — the checker
 * throws on an unknown keyword so the schema can never grow a rule this suite
 * quietly ignores.
 * @param {unknown} value
 * @param {JsonObject} sub  Subschema to check against.
 * @returns {boolean} true when `value` conforms.
 */
function conforms(value, sub) {
  const known = new Set([
    'type',
    'items',
    'minLength',
    'pattern',
    'required',
    'properties',
    'additionalProperties',
    'description',
  ]);
  for (const keyword of Object.keys(sub)) {
    assert.ok(known.has(keyword), `unsupported schema keyword '${keyword}' — extend this checker`);
  }

  const type = sub['type'];
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const items = /** @type {JsonObject|undefined} */ (sub['items']);
    return items === undefined || value.every((item) => conforms(item, items));
  }
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    const minLength = sub['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) return false;
    const pattern = sub['pattern'];
    if (pattern !== undefined) {
      // The only pattern this contract uses is `\S` — "contains a non-whitespace
      // character", the schema's expression of the validator's trim() check. It
      // is asserted rather than compiled: building a RegExp from a runtime value
      // is banned repo-wide, and pinning the literal means a schema that grows a
      // pattern this checker cannot honor fails here instead of passing silently.
      assert.equal(pattern, '\\S', `unsupported schema pattern '${String(pattern)}'`);
      if (!/\S/.test(value)) return false;
    }
    return true;
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const rec = /** @type {JsonObject} */ (value);
    const props = /** @type {JsonObject} */ (sub['properties'] ?? {});
    const required = /** @type {string[]} */ (sub['required'] ?? []);
    if (!required.every((key) => key in rec)) return false;
    if (sub['additionalProperties'] === false) {
      if (!Object.keys(rec).every((key) => key in props)) return false;
    }
    return Object.entries(rec).every(([key, v]) => {
      const propSchema = /** @type {JsonObject|undefined} */ (props[key]);
      return propSchema === undefined || conforms(v, propSchema);
    });
  }
  throw new assert.AssertionError({ message: `unsupported schema type '${String(type)}'` });
}

/**
 * @param {string} sub  'must-accept' | 'must-reject'
 * @returns {{ name: string, config: JsonObject }[]}
 */
function fixtures(sub) {
  return readdirSync(join(FIXTURES, sub))
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, config: readJson(join(FIXTURES, sub, name)) }));
}

/** The two keys this issue publishes, and the schema subschema for each. */
const SESSION_ARTIFACT_KEYS = ['sessionArtifactPaths', 'sessionArtifactWriters'];

test('schema declares both session-artifact keys (#93 published in the shared contract)', () => {
  for (const key of SESSION_ARTIFACT_KEYS) {
    assert.ok(key in properties, `docs/devmate-config.schema.json must declare ${key}`);
  }
});

test('schema does NOT bump schemaVersion — sessionArtifact* are additive fields', () => {
  const schemaVersion = /** @type {JsonObject} */ (properties['schemaVersion']);
  assert.deepEqual(schemaVersion['enum'], [1, 2]);
});

test('sessionArtifactPaths is an array of non-empty strings', () => {
  const sub = /** @type {JsonObject} */ (properties['sessionArtifactPaths']);
  assert.equal(conforms(['.devmate/state/**'], sub), true);
  assert.equal(conforms([], sub), true);
  assert.equal(conforms([''], sub), false, 'an empty glob must not validate');
  assert.equal(conforms('.devmate/state/**', sub), false, 'a bare string must not validate');
});

// The hand validator rejects whitespace-only strings (trim() !== ''); a schema
// that only bounded length would accept them, so a blank glob would clear editor
// validation and fail at config load — denying every source edit. The `\S`
// pattern keeps the two verdicts identical.
test('schema and hand validator agree on whitespace-only strings (both reject)', () => {
  const paths = /** @type {JsonObject} */ (properties['sessionArtifactPaths']);
  const writers = /** @type {JsonObject} */ (properties['sessionArtifactWriters']);
  assert.equal(conforms(['   '], paths), false, 'a whitespace-only path must not validate');
  assert.equal(
    conforms([{ glob: '   ', agents: ['spec-writer'] }], writers),
    false,
    'a whitespace-only glob must not validate',
  );
  assert.equal(
    conforms([{ glob: 'spec.md', agents: ['  '] }], writers),
    false,
    'a whitespace-only agent name must not validate',
  );

  const base = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['src/**'] }] };
  assert.equal(validateDevmateConfig({ ...base, sessionArtifactPaths: ['   '] }).ok, false);
  assert.equal(
    validateDevmateConfig({
      ...base,
      sessionArtifactWriters: [{ glob: '   ', agents: ['spec-writer'] }],
    }).ok,
    false,
  );
  assert.equal(
    validateDevmateConfig({
      ...base,
      sessionArtifactWriters: [{ glob: 'spec.md', agents: ['  '] }],
    }).ok,
    false,
  );
});

test('sessionArtifactWriters entries require glob + agents and forbid unknown keys', () => {
  const sub = /** @type {JsonObject} */ (properties['sessionArtifactWriters']);
  assert.equal(conforms([{ glob: 'spec.md', agents: ['spec-writer'] }], sub), true);
  assert.equal(conforms([{ glob: 'spec.md' }], sub), false, 'agents is required');
  assert.equal(conforms([{ agents: ['spec-writer'] }], sub), false, 'glob is required');
  assert.equal(conforms([{ glob: '', agents: [] }], sub), false, 'an empty glob must not validate');
  assert.equal(
    conforms([{ glob: 'spec.md', agents: [''] }], sub),
    false,
    'an empty agent name must not validate',
  );
  assert.equal(
    conforms([{ glob: 'spec.md', agents: ['spec-writer'], persona: 'editor' }], sub),
    false,
    'additionalProperties: false — a typo\'d key must not validate',
  );
});

test('schema accepts the session-artifact keys of every must-accept fixture', () => {
  const carriers = fixtures('must-accept').filter((f) =>
    SESSION_ARTIFACT_KEYS.some((key) => key in f.config),
  );
  assert.ok(carriers.length > 0, 'the corpus must cover the new keys on the accept side');
  for (const { name, config } of carriers) {
    for (const key of SESSION_ARTIFACT_KEYS) {
      if (!(key in config)) continue;
      const sub = /** @type {JsonObject} */ (properties[key]);
      assert.equal(conforms(config[key], sub), true, `${name}: ${key} should validate`);
    }
    assert.equal(validateDevmateConfig(config).ok, true, `${name}: hand validator should accept`);
  }
});

test('schema rejects the malformed session-artifact keys the must-reject fixtures carry', () => {
  const carriers = fixtures('must-reject').filter((f) =>
    SESSION_ARTIFACT_KEYS.some((key) => key in f.config),
  );
  assert.ok(carriers.length > 0, 'the corpus must cover the new keys on the reject side');
  for (const { name, config } of carriers) {
    const offending = SESSION_ARTIFACT_KEYS.filter((key) => key in config).some((key) => {
      const sub = /** @type {JsonObject} */ (properties[key]);
      return !conforms(config[key], sub);
    });
    assert.equal(offending, true, `${name}: the schema must reject its session-artifact key`);
    assert.equal(validateDevmateConfig(config).ok, false, `${name}: hand validator should reject`);
  }
});
