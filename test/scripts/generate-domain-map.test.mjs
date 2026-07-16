// @ts-check
/**
 * DN-4: generate-domain-map.mjs — drafts land only under .devmate/session/,
 * digest-only stdout, deterministic across runs on the same tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, DRAFT_PATH, STUBS_DIR } from '../../scripts/generate-domain-map.mjs';

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

/**
 * Materialize a small monorepo in a temp dir.
 * @returns {Promise<string>} repo root
 */
async function makeMonorepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'devmate-map-gen-'));
  const files = [
    'packages/billing/package.json',
    'packages/billing/src/index.ts',
    'packages/billing/src/invoice-service.ts',
    'packages/billing/src/refund-handler.ts',
    'packages/orders/package.json',
    'packages/orders/src/index.ts',
    'packages/orders/src/order-intake.ts',
    'src/notifications/email-sender.ts',
    'src/notifications/sms-sender.ts',
    'src/notifications/push-sender.ts',
    'src/notifications/digest-builder.ts',
    'src/notifications/webhook-sender.ts',
  ];
  await Promise.all(
    files.map(async (f) => {
      const abs = join(root, ...f.split('/'));
      await fsp.mkdir(join(abs, '..'), { recursive: true });
      await fsp.writeFile(abs, '// fixture\n', 'utf8');
    }),
  );
  return root;
}

/**
 * Recursively list repo-relative slash paths under `root`.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listTree(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(abs.slice(root.length + 1).split('\\').join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

test('generate-domain-map › writes draft + stubs under .devmate/session only, digest-only stdout', async () => {
  const root = await makeMonorepo();
  try {
    const before = await listTree(root);
    const { code, out } = await run(['--root', root]);
    assert.equal(code, 0);

    // Draft exists with sensible domains.
    const draft = JSON.parse(await fsp.readFile(join(root, ...DRAFT_PATH.split('/')), 'utf8'));
    assert.equal(draft.schemaVersion, 1);
    const ids = draft.domains.map((/** @type {{domain: string}} */ d) => d.domain);
    assert.deepEqual(ids.sort(), ['billing', 'notifications', 'orders']);
    for (const d of draft.domains) {
      assert.ok(Array.isArray(d.keywords) && d.keywords.length > 0, `${d.domain} has keywords`);
      assert.ok(Array.isArray(d.globs) && d.globs.length > 0, `${d.domain} has globs`);
    }

    // One stub per domain.
    const stubBodies = await Promise.all(
      ids.map((/** @type {string} */ id) =>
        fsp.readFile(join(root, ...STUBS_DIR.split('/'), `${id}.md`), 'utf8'),
      ),
    );
    for (const stub of stubBodies) {
      assert.match(stub, /DRAFT — edit before applying/);
    }

    // Digest only: counts + ids + paths; never stub contents.
    assert.match(out, /draft: 3 domain\(s\)/);
    assert.match(out, /domain-map-draft\.json/);
    assert.doesNotMatch(out, /DRAFT — edit before applying/);

    // No writes outside .devmate/session/.
    const after = await listTree(root);
    const created = after.filter((f) => !before.includes(f));
    assert.ok(created.length > 0, 'draft files were created');
    for (const f of created) {
      assert.match(f, /^\.devmate\/session\//, `unexpected write outside session dir: ${f}`);
    }
    assert.ok(!after.includes('.devmate/devmate.config.json'), 'config never created by generate');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('generate-domain-map › deterministic: two runs on the same tree produce identical drafts', async () => {
  const root = await makeMonorepo();
  try {
    assert.equal((await run(['--root', root])).code, 0);
    const first = await fsp.readFile(join(root, ...DRAFT_PATH.split('/')), 'utf8');
    assert.equal((await run(['--root', root])).code, 0);
    const second = await fsp.readFile(join(root, ...DRAFT_PATH.split('/')), 'utf8');
    assert.equal(second, first);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('generate-domain-map › consumes the FO-3 candidates artifact when present', async () => {
  const root = await makeMonorepo();
  try {
    const clusterFiles = [
      'services/payments/gateway-a.ts',
      'services/payments/gateway-b.ts',
      'services/payments/gateway-c.ts',
      'services/payments/gateway-d.ts',
      'services/payments/gateway-e.ts',
    ];
    await Promise.all(
      clusterFiles.map(async (f) => {
        const abs = join(root, ...f.split('/'));
        await fsp.mkdir(join(abs, '..'), { recursive: true });
        await fsp.writeFile(abs, '// fixture\n', 'utf8');
      }),
    );
    const artifactPath = join(root, '.devmate', 'state', 'discovery-candidates.json');
    await fsp.mkdir(join(artifactPath, '..'), { recursive: true });
    await fsp.writeFile(
      artifactPath,
      JSON.stringify({ schemaVersion: 1, candidates: clusterFiles.map((path) => ({ path })) }),
      'utf8',
    );

    const { code } = await run(['--root', root]);
    assert.equal(code, 0);
    const draft = JSON.parse(await fsp.readFile(join(root, ...DRAFT_PATH.split('/')), 'utf8'));
    assert.ok(
      draft.domains.some((/** @type {{domain: string}} */ d) => d.domain === 'payments'),
      'candidate cluster surfaced as a domain',
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
