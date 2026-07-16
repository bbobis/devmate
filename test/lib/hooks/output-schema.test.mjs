// @ts-check
/**
 * #77 — the output contract, and the shapes that used to violate it.
 *
 * Half of these cases are devmate's own former output. They are kept here as
 * named negative controls, because "the guard computes a correct deny" and "the
 * host acts on it" turned out to be very different claims, and nothing in the
 * repo could tell them apart.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_BLOCK,
  EXIT_OK,
  blockOutput,
  contextOutput,
  createTextCapture,
  preToolUseOutput,
  stopProcessingOutput,
  validateHookOutput,
  writeHookOutput,
} from '../../../lib/hooks/output-schema.mjs';

const json = (/** @type {unknown} */ v) => JSON.stringify(v);

describe('builders emit the shapes VS Code documents', () => {
  test('PreToolUse deny carries permissionDecision + reason', () => {
    const out = preToolUseOutput({ decision: 'deny', reason: 'gate closed' });
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'gate closed',
      },
    });
    assert.equal(validateHookOutput('PreToolUse', json(out), EXIT_OK).effect, 'block');
  });

  test('PostToolUse block is top-level, with the detail as context', () => {
    const out = blockOutput('PostToolUse', 'persona_scope_violation', 'edited lib/x.mjs');
    assert.equal(out['decision'], 'block');
    assert.equal(out['reason'], 'persona_scope_violation');
    assert.equal(validateHookOutput('PostToolUse', json(out), EXIT_OK).effect, 'block');
  });

  test('blockOutput refuses events that document no decision field', () => {
    // The failure mode this whole module exists to prevent: emitting a verdict
    // the host has no field for. It is now a throw at the call site, not a
    // silent no-op in production.
    assert.throws(() => blockOutput(/** @type {any} */ ('SubagentStart'), 'nope'), /no top-level decision/);
  });

  test('a SubagentStart stop uses the common format, which every event honors', () => {
    const out = stopProcessingOutput('spec not approved');
    assert.equal(out['continue'], false);
    assert.equal(validateHookOutput('SubagentStart', json(out), EXIT_OK).effect, 'block');
    // And exit 2 blocks on its own, whatever the host does with stdout.
    assert.equal(validateHookOutput('SubagentStart', '', EXIT_BLOCK).effect, 'block');
  });

  test('contextOutput returns null for events with no context channel', () => {
    assert.equal(contextOutput('PreCompact', 'compaction done'), null);
    assert.equal(contextOutput('Stop', 'handoff written'), null);
    assert.ok(contextOutput('SessionStart', 'repo memories'));
  });
});

describe('the shapes devmate used to emit are rejected', () => {
  test('{"decision":"allow"} on PreToolUse — the deny that never denied (#74)', () => {
    // The literal bytes from the user's agent log. VS Code reads
    // hookSpecificOutput.permissionDecision on PreToolUse; a bare `decision` is
    // the PostToolUse/Stop shape, so this verdict was dropped on the floor —
    // which is why edits "worked fine" while the gate believed it was enforcing.
    const check = validateHookOutput('PreToolUse', '{"decision":"allow"}', EXIT_OK);
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /not honored on PreToolUse/);
    assert.equal(check.effect, 'none', 'the host does nothing with it');
  });

  test('{"decision":"denied"} on SubagentStart — HITL-1 into the void (#77)', () => {
    const check = validateHookOutput('SubagentStart', '{"decision":"denied","reason":"x"}', EXIT_OK);
    assert.equal(check.ok, false);
    assert.equal(check.effect, 'none', 'the implementation dispatch proceeds');
  });

  test('{"ok":false,"reason":"persona_scope_violation"} — a reason with nothing to attach to', () => {
    const check = validateHookOutput(
      'PostToolUse',
      '{"ok":false,"reason":"persona_scope_violation"}',
      EXIT_OK,
    );
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /without decision:"block"/);
    assert.equal(check.effect, 'none');
  });

  test('raw text on stdout — the state anchor the model never saw', () => {
    const check = validateHookOutput('UserPromptSubmit', '<devmate-state>\ngate: impl-started\n', EXIT_OK);
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /not a single JSON document|not JSON/);
  });

  test('exit 1 is a WARNING, not a block — the contract validator that never halted', () => {
    const check = validateHookOutput('PostToolUse', '', 1);
    assert.equal(check.effect, 'warn');
    assert.notEqual(check.effect, 'block');
  });

  test('output on stdout with a non-zero exit is inert', () => {
    const check = validateHookOutput('PostToolUse', '{"decision":"block","reason":"x"}', 1);
    assert.match(check.warnings.join(' '), /only parses stdout on exit 0/);
  });

  test('a permissionDecision the host does not know is rejected', () => {
    const check = validateHookOutput(
      'PreToolUse',
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"denied"}}',
      EXIT_OK,
    );
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /allow\|deny\|ask/);
  });

  test('a mismatched hookEventName is rejected', () => {
    const check = validateHookOutput(
      'PostToolUse',
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}',
      EXIT_OK,
    );
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /but the event is PostToolUse/);
  });

  test("devmate's internal keys ride along harmlessly", () => {
    // {ok, fact, …} is not in the host's vocabulary, so it is ignored — a
    // warning, not an error. Tolerating this is what let the fix land without
    // rewriting every hook's internal result shape.
    const check = validateHookOutput('PostToolUse', '{"ok":true,"fact":{"path":"lib/x.mjs"}}', EXIT_OK);
    assert.equal(check.ok, true);
    assert.match(check.warnings.join(' '), /unknown key/);
  });

  test('empty stdout on exit 0 is valid — silence is a legal answer', () => {
    const check = validateHookOutput('SubagentStart', '', EXIT_OK);
    assert.deepEqual(check.errors, []);
    assert.equal(check.effect, 'none');
  });
});

describe('writeHookOutput routes by what the host will read', () => {
  /** @returns {{ stream: NodeJS.WritableStream, text: () => string }} */
  const sink = () => createTextCapture();

  test('exit 0 + human text → wrapped in the event context envelope', () => {
    const out = sink();
    const err = sink();
    writeHookOutput('SessionStart', 'Repo memories: 3\n', EXIT_OK, {
      stdout: out.stream,
      stderr: err.stream,
    });
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Repo memories: 3/);
    assert.equal(err.text(), '');
  });

  test('exit 0 + text on an event with NO context channel → stderr, not an invented field', () => {
    const out = sink();
    const err = sink();
    writeHookOutput('PreCompact', 'Compaction written\n', EXIT_OK, {
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(out.text(), '', 'nothing invented on stdout');
    assert.match(err.text(), /Compaction written/);
  });

  test('non-zero exit → text goes to stderr, stdout stays empty', () => {
    const out = sink();
    const err = sink();
    writeHookOutput('PostToolUse', '[BUDGET:critical] over limit\n', EXIT_BLOCK, {
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(out.text(), '', 'the host never parses stdout on a non-zero exit');
    assert.match(err.text(), /BUDGET:critical/);
  });

  test('a hook that already emitted conforming JSON passes through untouched', () => {
    const out = sink();
    const built = json(blockOutput('PostToolUse', 'tdd_skipped', 'write the test first'));
    writeHookOutput('PostToolUse', built, EXIT_OK, { stdout: out.stream, stderr: sink().stream });
    assert.deepEqual(JSON.parse(out.text()), JSON.parse(built));
  });

  test('every routed result is itself contract-valid', () => {
    // The property that matters: whatever goes in, what comes out conforms.
    for (const [event, text, code] of /** @type {[any, string, number][]} */ ([
      ['SessionStart', 'hello\n', 0],
      ['UserPromptSubmit', '<devmate-state>\ngate: x\n', 0],
      ['PreCompact', 'done\n', 0],
      ['PostToolUse', '[BUDGET:warn]\n', 1],
      ['Stop', '', 0],
    ])) {
      const out = sink();
      writeHookOutput(event, text, code, { stdout: out.stream, stderr: sink().stream });
      const check = validateHookOutput(event, out.text(), code);
      assert.deepEqual(check.errors, [], `${event} produced output the host would drop`);
    }
  });
});
