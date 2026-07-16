// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { join as joinPath } from 'node:path';
import { readTaskState, writeTaskState } from '../lib/task-state.mjs';
import { transitionGate } from '../lib/gate-transitions.mjs';
import {
  advanceHumanGate,
  appendGateTransitionEvent,
  HUMAN_APPROVAL_GATES,
  isHumanApprovalGate,
} from '../lib/gatectl.mjs';
import {
  setDependencyGate,
  getDependencyGate,
  listDependencyGates,
  DEP_GATES,
} from '../lib/dependency-gates.mjs';

/** @typedef {import('../lib/types.mjs').GateEvent} GateEvent */
/** @typedef {import('../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../lib/types.mjs').DepGateName} DepGateName */
/** @typedef {import('../lib/types.mjs').DepGateStatus} DepGateStatus */

/**
 * Print usage information to stderr.
 * @returns {void}
 */
function printUsage() {
  process.stderr.write(
    'Usage:\n' +
    '  gatectl workflow set [event] --actor [who] --evidence [msg]     Advance workflow gate by event name.\n' +
    '  gatectl workflow approve [gate] --actor [who] --evidence [msg]  Advance a human gate with an audit trail.\n' +
    '  gatectl dependency set [name] [status] [--force]    Write a named dependency gate.\n' +
    '  gatectl dependency get [name]                       Read a named dependency gate.\n' +
    '  gatectl dependency list                             List all dependency gate entries.\n' +
    '\n' +
    '  --force  Bypass prerequisite order check; violation is logged to gate-violations.jsonl.\n' +
    '  --actor / --evidence  REQUIRED whenever a transition enters a human gate\n' +
    `  (${HUMAN_APPROVAL_GATES.join(', ')}): who issued the transition and the verbatim\n` +
    '  human message that approved it. Both are written to the gate_transition trace event.\n' +
    '\n' +
    'Deprecated aliases (emit warning, still work):\n' +
    '  gatectl set-workflow-gate [event]\n' +
    '  gatectl set-dependency-gate [name] [status]\n' +
    '\n' +
    'Workflow gate events: approve-plan, draft-spec, start-impl, pass-verification, mark-pr-ready, complete\n' +
    '  (feature lane: draft-spec is the only legal event from plan-approved; start-impl\n' +
    '  is legal only from spec-approved. Bug/chore: start-impl from plan-approved.)\n' +
    `Human-approval gates: ${HUMAN_APPROVAL_GATES.join(', ')}\n` +
    `Dependency gate names: ${[...DEP_GATES].join(', ')}\n` +
    'Dependency gate statuses: pending, pass, fail, skipped\n'
  );
}

/**
 * Parse `--actor <value>` / `--evidence <value>` out of argv tokens using
 * explicit positional checks (mirrors scripts/orch-assert-router.mjs).
 * Returns the remaining tokens with both flag pairs removed.
 * @param {string[]} args
 * @returns {{ actor: string|undefined, evidence: string|undefined, rest: string[] }}
 */
function parseAuditFlags(args) {
  /** @type {string|undefined} */
  let actor;
  /** @type {string|undefined} */
  let evidence;
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args.at(i);
    if (a === undefined) continue;
    const next = args.at(i + 1);
    if (a === '--actor' && next !== undefined) {
      actor = next;
      i += 1;
    } else if (a === '--evidence' && next !== undefined) {
      evidence = next;
      i += 1;
    } else {
      rest.push(a);
    }
  }
  return { actor, evidence, rest };
}

/**
 * True when the value is a non-empty, non-whitespace string.
 * @param {string|undefined} value
 * @returns {value is string}
 */
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Main entry point.
 * @param {string[]} args  Process argv after the script name (process.argv.slice(2)).
 * @returns {Promise<number>} Exit code.
 */
export async function main(args) {
  const [sub, ...rest] = args;

  // Resolve the workspace root ONCE. The integrated terminal this CLI runs in
  // opens at workspaceFolders[0] — which monoroot makes the workspace's own
  // .devmate/ folder — so every cwd-relative read/write here had the same
  // doubled-path hazard as the hooks (#76).
  const cliRoot = resolveHookRoot();

  // ── Deprecated alias: set-workflow-gate <event> ──────────────────────────
  if (sub === 'set-workflow-gate') {
    process.stderr.write(
      '[devmate] DEPRECATED: "gatectl set-workflow-gate" is deprecated. ' +
      'Use "gatectl workflow set [event]" instead.\n'
    );
    return main(['workflow', 'set', ...rest]);
  }

  // ── Deprecated alias: set-dependency-gate <name> <status> ────────────────
  if (sub === 'set-dependency-gate') {
    process.stderr.write(
      '[devmate] DEPRECATED: "gatectl set-dependency-gate" is deprecated. ' +
      'Use "gatectl dependency set [name] [status]" instead.\n'
    );
    return main(['dependency', 'set', ...rest]);
  }

  // ── workflow ──────────────────────────────────────────────────────────────
  if (sub === 'workflow') {
    const { actor, evidence, rest: wfRest } = parseAuditFlags(rest);
    const [action, arg] = wfRest;

    // E10-03: orchestrator-issued human-gate advance with an audit trail.
    if (action === 'approve') {
      if (!arg) {
        process.stderr.write('Error: expected "gatectl workflow approve [gate] --actor [who] --evidence [msg]".\n');
        printUsage();
        return 1;
      }
      if (!isHumanApprovalGate(arg)) {
        process.stderr.write(
          `Error: "workflow approve" targets a human gate (${HUMAN_APPROVAL_GATES.join(', ')}); got "${arg}".\n`
        );
        return 1;
      }
      if (!isNonEmpty(actor) || !isNonEmpty(evidence)) {
        process.stderr.write(
          `Error: human-gate transition to "${arg}" requires --actor [who] and --evidence "[verbatim human message]".\n`
        );
        return 1;
      }
      const stateResult = readTaskState(joinPath(cliRoot, '.devmate/state/task.json'));
      if (!stateResult.ok) {
        process.stderr.write(`Error reading task state: ${stateResult.errors.join('; ')}\n`);
        return 1;
      }
      try {
        const advanced = await advanceHumanGate(
          stateResult.state.workflowGate,
          /** @type {WorkflowGate} */ (arg),
          { actor, evidence, root: cliRoot }
        );
        process.stdout.write(`Gate advanced: ${advanced.from} → ${advanced.to} (actor: ${actor})\n`);
        return 0;
      } catch (/** @type {unknown} */ err) {
        process.stderr.write(`Gate transition failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }

    if (action !== 'set' || !arg) {
      process.stderr.write('Error: expected "gatectl workflow set [event]" or "gatectl workflow approve [gate]".\n');
      printUsage();
      return 1;
    }
    const stateResult = readTaskState(joinPath(cliRoot, '.devmate/state/task.json'));
    if (!stateResult.ok) {
      process.stderr.write(`Error reading task state: ${stateResult.errors.join('; ')}\n`);
      return 1;
    }
    const result = await transitionGate(stateResult.state, /** @type {GateEvent} */ (arg));
    if (!result.ok) {
      process.stderr.write(`Gate transition failed: ${result.error}\n`);
      return 1;
    }
    if (!result.state || result.from === undefined || result.to === undefined) {
      process.stderr.write('Internal error: transition ok but state missing.\n');
      return 1;
    }
    // E10-03: an event whose target is a human gate is a human-gate
    // transition — refuse it without the actor/evidence audit pair.
    const enteringHumanGate = isHumanApprovalGate(result.to);
    if (enteringHumanGate && (!isNonEmpty(actor) || !isNonEmpty(evidence))) {
      process.stderr.write(
        `Error: event "${arg}" enters human gate "${result.to}" — ` +
        '--actor [who] and --evidence "[verbatim human message]" are required.\n'
      );
      return 1;
    }
    await writeTaskState(result.state, joinPath(cliRoot, '.devmate/state/task.json'));
    if (enteringHumanGate && isNonEmpty(actor) && isNonEmpty(evidence)) {
      await appendGateTransitionEvent({
        taskId: result.state.taskId,
        from: result.from,
        to: result.to,
        actor,
        evidence,
        root: cliRoot,
      });
    }
    process.stdout.write(`Gate advanced: ${result.from} → ${result.to}\n`);
    return 0;
  }

  // ── dependency ────────────────────────────────────────────────────────────
  if (sub === 'dependency') {
    const [action, ...depRest] = rest;

    if (action === 'set') {
      // Parse --force flag anywhere in the remaining args
      const forceIdx = depRest.indexOf('--force');
      const force = forceIdx !== -1;
      const filteredRest = depRest.filter((a) => a !== '--force');
      const [name, status] = filteredRest;
      if (!name || !status) {
        process.stderr.write('Error: expected "gatectl dependency set [name] [status] [--force]".\n');
        printUsage();
        return 1;
      }
      if (force) {
        process.stderr.write(
          `WARNING: forcing out-of-order gate ${name}; violation logged.\n`
        );
      }
      try {
        await setDependencyGate(
          /** @type {DepGateName} */ (name),
          /** @type {DepGateStatus} */ (status),
          undefined,
          { force }
        );
        process.stdout.write(`Dependency gate "${name}" set to "${status}".\n`);
        return 0;
      } catch (/** @type {unknown} */ err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }

    if (action === 'get') {
      const [name] = depRest;
      if (!name) {
        process.stderr.write('Error: expected "gatectl dependency get [name]".\n');
        printUsage();
        return 1;
      }
      const entry = getDependencyGate(/** @type {DepGateName} */ (name));
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
      return 0;
    }

    if (action === 'list') {
      const gates = listDependencyGates();
      process.stdout.write(JSON.stringify(gates, null, 2) + '\n');
      return 0;
    }

    process.stderr.write(`Error: unknown dependency subcommand "${action}".\n`);
    printUsage();
    return 1;
  }

  // ── unknown subcommand ────────────────────────────────────────────────────
  process.stderr.write(`Error: unknown subcommand "${sub}".\n`);
  printUsage();
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then(process.exit);
}
