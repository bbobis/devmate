// @ts-check
/**
 * DN-4: apply-domain-map.mjs — the human gate. Fail-closed on a missing or
 * invalid draft, merge without clobbering unrelated config keys, idempotent
 * re-apply, stubs copied to .devmate/contexts/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/apply-domain-map.mjs';
import { DRAFT_PATH, STUBS_DIR } from '../../scripts/generate-domain-map.mjs';

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function run(args) {
  /** @type {string[]} */
  const outChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  const code = await main(args, {
    out: (s) => outChunks.push(s),
    err: (s) => errChunks.push(s),
  });
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

/** A valid draft domain entry. @param {string} id @param {object} [extra] */
function draftDomain(id, extra = {}) {
  return {
    domain: id,
    keywords: [id, 'invoice'],
    globs: [`packages/${id}/**`],
    contextFile: `.devmate/contexts/${id}.md`,
    relatedDomains: [],
    ...extra,
  };
}

/**
 * Temp repo with a valid config, a draft, and stub files.
 * @param {{ config?: object|null, draft?: object|null, stubIds?: string[] }} [opts]
 * @returns {Promise<string>} repo root
 */
async function makeRepo(opts = {}) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'devmate-map-apply-'));
  await fsp.mkdir(join(root, '.devmate', 'session'), { recursive: true });

  const config =
    opts.config === undefined
      ? {
          schemaVersion: 1,
          personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
          verification: { unitTest: 'npm test' },
        }
      : opts.config;
  if (config !== null) {
    await fsp.writeFile(
      join(root, '.devmate', 'devmate.config.json'),
      JSON.stringify(config, null, 2),
      'utf8',
    );
  }

  const draft = opts.draft === undefined ? { schemaVersion: 1, domains: [draftDomain('billing')] } : opts.draft;
  if (draft !== null) {
    await fsp.writeFile(join(root, ...DRAFT_PATH.split('/')), JSON.stringify(draft, null, 2), 'utf8');
  }

  await Promise.all(
    (opts.stubIds ?? []).map(async (id) => {
      const stubPath = join(root, ...STUBS_DIR.split('/'), `${id}.md`);
      await fsp.mkdir(join(stubPath, '..'), { recursive: true });
      await fsp.writeFile(stubPath, `# ${id} — domain context (DRAFT — edit before applying)\n`, 'utf8');
    }),
  );
  return root;
}

/** @param {string} root @returns {Promise<any>} */
async function readConfig(root) {
  return JSON.parse(await fsp.readFile(join(root, '.devmate', 'devmate.config.json'), 'utf8'));
}

test('apply-domain-map › valid draft merges domains and copies stubs without clobbering unrelated keys', async () => {
  const root = await makeRepo({ stubIds: ['billing'] });
  try {
    const { code, out } = await run(['--root', root]);
    assert.equal(code, 0);

    const config = await readConfig(root);
    assert.deepEqual(config.domains.map((/** @type {{domain:string}} */ d) => d.domain), ['billing']);
    // Unrelated keys preserved untouched.
    assert.deepEqual(config.personas, [{ persona: 'backend', editableGlobs: ['src/**'] }]);
    assert.deepEqual(config.verification, { unitTest: 'npm test' });

    // Stub copied to the live contexts dir.
    const applied = await fsp.readFile(join(root, '.devmate', 'contexts', 'billing.md'), 'utf8');
    assert.match(applied, /billing — domain context/);

    // Digest-only output.
    assert.match(out, /merged 1 draft domain\(s\)/);
    assert.match(out, /copied 1 context stub\(s\)/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › merging an existing id updates it in place — never duplicates', async () => {
  const root = await makeRepo({
    config: {
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
      domains: [draftDomain('billing', { keywords: ['old'] }), draftDomain('orders')],
    },
    draft: { schemaVersion: 1, domains: [draftDomain('billing', { keywords: ['invoice', 'refund'] })] },
  });
  try {
    const { code } = await run(['--root', root]);
    assert.equal(code, 0);
    const config = await readConfig(root);
    assert.deepEqual(
      config.domains.map((/** @type {{domain:string}} */ d) => d.domain),
      ['billing', 'orders'],
      'no duplicate ids',
    );
    assert.deepEqual(config.domains[0].keywords, ['invoice', 'refund'], 'existing id updated');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › re-applying the same draft is idempotent (byte-identical config)', async () => {
  const root = await makeRepo({ stubIds: ['billing'] });
  try {
    assert.equal((await run(['--root', root])).code, 0);
    const first = await fsp.readFile(join(root, '.devmate', 'devmate.config.json'), 'utf8');
    assert.equal((await run(['--root', root])).code, 0);
    const second = await fsp.readFile(join(root, '.devmate', 'devmate.config.json'), 'utf8');
    assert.equal(second, first);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › invalid draft is rejected naming the bad field; config untouched', async () => {
  const root = await makeRepo({
    draft: {
      schemaVersion: 1,
      domains: [{ ...draftDomain('billing'), bogusKey: true }],
    },
  });
  try {
    const before = await fsp.readFile(join(root, '.devmate', 'devmate.config.json'), 'utf8');
    const { code, err } = await run(['--root', root]);
    assert.equal(code, 1);
    assert.match(err, /unknown key 'bogusKey'/);
    const after = await fsp.readFile(join(root, '.devmate', 'devmate.config.json'), 'utf8');
    assert.equal(after, before, 'nothing written on rejection');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › missing draft fails closed naming the generate step', async () => {
  const root = await makeRepo({ draft: null });
  try {
    const { code, err } = await run(['--root', root]);
    assert.equal(code, 1);
    assert.match(err, /no draft at \.devmate\/session\/domain-map-draft\.json/);
    assert.match(err, /generate-domain-map/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › missing devmate.config.json fails closed pointing at init', async () => {
  const root = await makeRepo({ config: null });
  try {
    const { code, err } = await run(['--root', root]);
    assert.equal(code, 1);
    assert.match(err, /run devmate init/);
    assert.ok(!existsSync(join(root, '.devmate', 'devmate.config.json')), 'config never invented');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('apply-domain-map › malformed draft JSON shape fails closed', async () => {
  const root = await makeRepo({ draft: { schemaVersion: 1, domains: 'nope' } });
  try {
    const { code, err } = await run(['--root', root]);
    assert.equal(code, 1);
    assert.match(err, /malformed/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
