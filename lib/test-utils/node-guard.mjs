// @ts-check

/**
 * True when the running Node major version is >= min.
 * @param {number} min
 * @returns {boolean}
 */
export function nodeMajorAtLeast(min) {
  const major = Number(process.versions.node.split('.')[0]);
  return !Number.isNaN(major) && major >= min;
}

/**
 * Returns a node:test options object that skips a test when the runtime Node
 * major is below `min`, with a message pointing at the entrypoint guard.
 * @param {number} min
 * @returns {{ skip: string | false }}
 */
export function skipUnlessNode(min) {
  if (nodeMajorAtLeast(min)) {
    return { skip: false };
  }
  return {
    skip:
      `requires Node >= ${min} (running ${process.versions.node}); ` +
      `spawned entrypoints call assertNodeVersion(${min}) (lib/env-guard.mjs) and exit before emitting output`,
  };
}
