// @ts-check
/**
 * E2-5 regression: the argv executor runs commands with no shell, so spaces and
 * shell metacharacters in arguments are passed literally — never expanded or
 * interpreted. argv[0] containing metacharacters is rejected outright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, validateArgv } from '../../lib/loop/run-command.mjs';

test('quoting › spaces in argv do not expand', async () => {
  // A single argument containing spaces must reach the program intact as ONE arg.
  const phrase = 'hello   world  with spaces';
  const result = await runCommand(['node', '-e', `process.stdout.write(process.argv[1])`, phrase], {
    timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 0);
  // The phrase is argv[1] to the inline script; spacing preserved verbatim.
  assert.equal(result.stdout, phrase, 'spaces preserved, no word-splitting');
});

test('quoting › shell metacharacters are not interpreted', async () => {
  // Pass a classic injection fragment as a literal argument.
  const evil = '; rm -rf / && echo PWNED `whoami` $(id)';
  const result = await runCommand(
    ['node', '-e', 'process.stdout.write(process.argv[1])', evil],
    { timeoutMs: 5000 }
  );
  assert.equal(result.exitCode, 0);
  // The metacharacters arrive verbatim — nothing was expanded or executed.
  assert.equal(result.stdout, evil, 'metacharacters passed literally');
  assert.ok(!result.stdout.includes('PWNED\n'), 'no command substitution ran');

  // argv[0] with metacharacters is rejected before any spawn.
  assert.throws(
    () => validateArgv(['echo; rm -rf /', 'arg']),
    /** @param {Error & {code?: string}} err */
    (err) => err.code === 'SHELL_METACHAR_IN_ARGV0'
  );
});
