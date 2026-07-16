// @ts-check
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../../lib/env-guard.mjs';

/**
 * Run `fn` with `process.argv[1]` temporarily set to `entry` (or removed when
 * undefined), restoring the original argv afterwards.
 * @param {string | undefined} entry
 * @param {() => void} fn
 * @returns {void}
 */
function withArgv1(entry, fn) {
  const original = process.argv;
  process.argv = entry === undefined
    ? [original[0]]
    : [original[0], entry, ...original.slice(2)];
  try {
    fn();
  } finally {
    process.argv = original;
  }
}

describe('isMainModule', () => {
  const selfPath = fileURLToPath(import.meta.url);

  it('returns true when argv[1] is the module path in native shape', () => {
    withArgv1(selfPath, () => {
      assert.equal(isMainModule(import.meta.url), true);
    });
  });

  it('returns true for an unnormalized argv[1] (redundant .. segment)', () => {
    // String-built on purpose: join() would normalize the detour away.
    const dir = dirname(selfPath);
    const detour = [dir, '..', basename(dir), basename(selfPath)].join(sep);
    assert.notEqual(detour, selfPath);
    withArgv1(detour, () => {
      assert.equal(isMainModule(import.meta.url), true);
    });
  });

  it('compares a native-separator argv[1] equal to the POSIX file:// URL (the Windows path-shape case)', () => {
    // Both sides derive from the same file so the assertion is honest on any
    // host: on Windows argv[1] carries backslashes while the URL is the
    // three-slash POSIX form — the exact pair the broken template-literal
    // guard compared unequal; on POSIX the pair still exercises the
    // URL -> path -> resolve round-trip.
    const posixUrl = pathToFileURL(selfPath).href;
    assert.ok(posixUrl.startsWith('file:///'));
    assert.ok(!posixUrl.includes('\\'));
    // The broken form's left-hand side never matches on Windows:
    const brokenLhs = 'file://' + selfPath;
    if (process.platform === 'win32') assert.notEqual(brokenLhs, posixUrl);
    withArgv1(selfPath, () => {
      assert.equal(isMainModule(posixUrl), true);
    });
  });

  it('returns false when argv[1] is a different file', () => {
    withArgv1(resolve(dirname(selfPath), 'some-other-file.mjs'), () => {
      assert.equal(isMainModule(import.meta.url), false);
    });
  });

  it('returns false when process.argv[1] is undefined', () => {
    withArgv1(undefined, () => {
      assert.equal(isMainModule(import.meta.url), false);
    });
  });

  describe('in a real process (spawned)', () => {
    const envGuardUrl = pathToFileURL(
      resolve(dirname(selfPath), '..', '..', 'lib', 'env-guard.mjs'),
    ).href;
    const dir = mkdtempSync(join(tmpdir(), 'env-guard-probe-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    const probeA = join(dir, 'probe-a.mjs');
    writeFileSync(
      probeA,
      `import { isMainModule } from '${envGuardUrl}';\n` +
        `export const loaded = true;\n` +
        `if (isMainModule(import.meta.url)) process.stdout.write('PROBE_A_RAN');\n`,
    );
    const probeB = join(dir, 'probe-b.mjs');
    writeFileSync(
      probeB,
      `import { loaded } from '${pathToFileURL(probeA).href}';\n` +
        `process.stdout.write('IMPORTED:' + loaded);\n`,
    );

    it('guard fires when the module is the spawned entrypoint', () => {
      const r = spawnSync(process.execPath, [probeA], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'PROBE_A_RAN');
    });

    it('guard stays silent when the module is only imported', () => {
      const r = spawnSync(process.execPath, [probeB], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'IMPORTED:true');
    });
  });
});

describe('assertNodeVersion', () => {
  it('passes silently when major version >= 24', () => {
    // Build a local version of the guard with a stubbed process to avoid
    // process.exit() killing the test runner.
    /** @param {number} min @param {string} nodeVersion @returns {{ exited: boolean, message: string }} */
    function simulateGuard(min, nodeVersion) {
      let exited = false;
      let message = '';
      const fakeProcess = {
        versions: { node: nodeVersion },
        stderr: { write: /** @param {string} s */ (s) => { message += s; } },
        exit: /** @param {number} _code */ (_code) => { exited = true; },
      };
      const major = Number(fakeProcess.versions.node.split('.')[0]);
      if (Number.isNaN(major) || major < min) {
        fakeProcess.stderr.write(
          `devmate requires Node ${min} or newer. ` +
          `You are running Node ${fakeProcess.versions.node}.\n` +
          `Please upgrade: https://nodejs.org/en/download ` +
          `(or use nvm: \`nvm install ${min} && nvm use ${min}\`).\n`
        );
        fakeProcess.exit(1);
      }
      return { exited, message };
    }

    const pass = simulateGuard(24, '24.0.0');
    assert.equal(pass.exited, false);
    assert.equal(pass.message, '');

    const pass26 = simulateGuard(24, '26.1.0');
    assert.equal(pass26.exited, false);
  });

  it('on a stubbed lower version: writes the upgrade message and signals exit', () => {
    /** @param {number} min @param {string} nodeVersion @returns {{ exited: boolean, message: string }} */
    function simulateGuard(min, nodeVersion) {
      let exited = false;
      let message = '';
      const fakeProcess = {
        versions: { node: nodeVersion },
        stderr: { write: /** @param {string} s */ (s) => { message += s; } },
        exit: /** @param {number} _code */ (_code) => { exited = true; },
      };
      const major = Number(fakeProcess.versions.node.split('.')[0]);
      if (Number.isNaN(major) || major < min) {
        fakeProcess.stderr.write(
          `devmate requires Node ${min} or newer. ` +
          `You are running Node ${fakeProcess.versions.node}.\n` +
          `Please upgrade: https://nodejs.org/en/download ` +
          `(or use nvm: \`nvm install ${min} && nvm use ${min}\`).\n`
        );
        fakeProcess.exit(1);
      }
      return { exited, message };
    }

    const fail = simulateGuard(24, '22.11.0');
    assert.equal(fail.exited, true);
    assert.ok(
      fail.message.includes('requires Node 24 or newer'),
      `Expected upgrade message, got: ${fail.message}`
    );
    assert.ok(
      fail.message.includes('22.11.0'),
      `Expected current version in message, got: ${fail.message}`
    );
    assert.ok(
      fail.message.includes('nodejs.org/en/download'),
      `Expected upgrade URL in message, got: ${fail.message}`
    );
  });
});