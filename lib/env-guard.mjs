// @ts-check
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module identified by `metaUrl` is the process entrypoint
 * (run directly), false when imported (e.g. by a test). Cross-platform:
 * normalizes both sides through the filesystem path space, so Windows
 * backslash/native paths and POSIX file:// URLs compare equal.
 * @param {string} metaUrl  Pass `import.meta.url`.
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(metaUrl));
}

/**
 * Assert the running Node.js major version is at least `min`.
 * Prints a friendly message and exits(1) if not satisfied.
 * @param {number} [min=24]
 * @returns {void}
 */
export function assertNodeVersion(min = 24) {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < min) {
    process.stderr.write(
      `devmate requires Node ${min} or newer. ` +
      `You are running Node ${process.versions.node}.\n` +
      `Please upgrade: https://nodejs.org/en/download ` +
      `(or use nvm: \`nvm install ${min} && nvm use ${min}\`).\n`
    );
    process.exit(1);
  }
}