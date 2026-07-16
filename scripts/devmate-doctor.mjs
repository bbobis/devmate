// @ts-check
// Agent-invoked entrypoint: health-check the three-stage memory pipeline
// (task ledgers → repo ledger → .devmate/MEMORY.md) and report the first broken stage.
// Also runs a gate-evidence consistency check (lib/gate-consistency.mjs): proves
// the persisted workflowGate is backed by the artifacts + audit events it legally
// requires, and — behind the opt-in `--fix` flag — reconciles a desynced gate to
// the last evidence-backed gate. A desynced, unreconciled gate makes this command
// exit 1.
// Also runs DN-1 business-domain doctor checks (declared-but-missing
// contextFile, dangling relatedDomains id, missing entryPoints path) when
// the repo's devmate.config.json declares a `domains` array — warnings only,
// never affecting this command's exit code.
// Prints a compact JSON summary to stdout and human-readable findings to
// stderr; writes the full diagnosis to .devmate/state/memory-doctor-result.json
// for read_file access. Never prints ledger contents.
import { resolve, dirname } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { diagnoseMemory } from '../lib/memory/doctor.mjs';
import { checkDomainConfig } from '../lib/config/domain-doctor.mjs';
import { loadDevmateConfig, CONFIG_PATH } from '../lib/config/devmate-config.mjs';
import { writeResult } from '../lib/output/write-result.mjs';
import {
  checkGateConsistency,
  pruneArtifactHashesForRollback,
} from '../lib/gate-consistency.mjs';
import { readTaskState, validateTaskState, STATE_PATH } from '../lib/task-state.mjs';
import { ensureDirSync, writeTextFileSync, renamePathSync } from '../lib/fs-safe.mjs';
import { LOCK_SUFFIX, withFileLock } from '../lib/file-lock.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';

/**
 * Parse `--key value` / `--key=value` args into a flat map.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = args.at(i + 1);
      if (next !== undefined && !next.startsWith('--')) {
        out.set(a.slice(2), next);
        i += 1;
      } else {
        out.set(a.slice(2), 'true');
      }
    }
  }
  return out;
}

/** @typedef {import('../lib/gate-consistency.mjs').GateConsistencyResult} GateConsistencyResult */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * Gate-evidence consistency stage: prove the persisted `workflowGate` is backed
 * by the artifacts + audit events it legally requires. Detection is always
 * non-destructive; the rewrite is opt-in behind `--fix`.
 *
 * When `fix` is set and a desync is found, the read → decide → write → re-check
 * cycle runs INSIDE the same file lock the write uses, so no concurrent writer
 * can slip between the consistency read and the reconcile (closes the TOCTOU).
 * The gate is rolled back to the last evidence-backed gate, stale
 * artifact-hash trust residue is pruned, and an audited `gate_transition` is
 * stamped — but only when that rollback would actually MOVE the gate. A
 * divergence a rollback cannot resolve (a backward tamper whose gate is already
 * evidence-backed, or a corrupt trace) is NOT papered over with a no-op write:
 * it is left in place and reported. `fixed` is true only when the post-fix
 * re-check comes back clean.
 * @param {string} root
 * @param {boolean} fix
 * @returns {Promise<{ consistency: GateConsistencyResult|null, fixed: boolean }>}
 */
async function runGateConsistency(root, fix) {
  const statePath = resolve(root, STATE_PATH);
  const stateResult = readTaskState(statePath);
  // No task in flight (or an unreadable/corrupt state file) is not this stage's
  // concern — readTaskState already surfaced the reason; nothing to reconcile.
  if (!stateResult.ok) return { consistency: null, fixed: false };

  const consistency = await checkGateConsistency(stateResult.state, { root });
  if (consistency.ok || !fix) return { consistency, fixed: false };

  // --fix path. Everything below runs under the task-state lock: we re-read
  // INSIDE the lock and re-derive the target from that fresh read, so the value
  // we reconcile against is the one on disk at write time, not a stale snapshot.
  ensureDirSync(dirname(statePath));
  const lockPath = statePath + LOCK_SUFFIX;
  /** @type {{ consistency: GateConsistencyResult, fixed: boolean }} */
  let outcome = { consistency, fixed: false };

  const lockResult = await withFileLock(lockPath, async () => {
    const fresh = readTaskState(statePath);
    // State went unreadable in the race window — nothing safe to reconcile.
    if (!fresh.ok) return;

    const locked = await checkGateConsistency(fresh.state, { root });
    // A concurrent writer already reconciled it — report the clean result.
    if (locked.ok) {
      outcome = { consistency: locked, fixed: false };
      return;
    }

    const from = fresh.state.workflowGate;
    const target = locked.evidenceBackedGate;

    // A rollback that would not move the gate cannot fix this divergence class
    // (a backward tamper's gate is already evidence-backed; a corrupt trace is
    // not un-corrupted by a gate rewrite). Do NOT stamp a no-op transition —
    // report the remaining divergence and leave recovery to a human.
    if (target === from) {
      outcome = { consistency: locked, fixed: false };
      return;
    }

    // Roll back: reset currentStep so a resumed session does not believe it is
    // partway through a step it never began, and prune artifact-hash trust
    // residue for gates now behind the rollback target.
    const reconciled = /** @type {TaskState} */ ({
      ...fresh.state,
      workflowGate: target,
      currentStep: 0,
      artifactHashes: pruneArtifactHashesForRollback(fresh.state.artifactHashes, target),
    });
    const valid = validateTaskState(reconciled);
    if (!valid.ok) {
      throw new Error(`doctor --fix produced invalid state: ${valid.errors.join('; ')}`);
    }
    // Inline atomic write (tmp + rename). We already hold the state lock, so we
    // must NOT call writeTaskState here — it would re-acquire the same lock and
    // deadlock.
    const tmpPath = statePath + '.tmp';
    writeTextFileSync(tmpPath, JSON.stringify(reconciled, null, 2));
    renamePathSync(tmpPath, statePath);

    await appendTraceEvent(
      {
        type: 'gate_transition',
        taskId: fresh.state.taskId,
        stepId: 'devmate-doctor-fix',
        ts: new Date().toISOString(),
        schemaVersion: 1,
        from,
        to: target,
        gate: target,
        actor: 'devmate-doctor',
        evidence: `reconciled desynced gate "${from}" to last evidence-backed gate "${target}" (--fix)`,
      },
      { root },
    );

    const rechecked = await checkGateConsistency(reconciled, { root });
    // Claim reconciled ONLY when the post-fix re-check is actually clean.
    outcome = { consistency: rechecked, fixed: rechecked.ok };
  });

  // Could not acquire the lock (a writer holds it): report detection unchanged.
  if (!lockResult.acquired) return { consistency, fixed: false };
  return outcome;
}

/**
 * Entrypoint. `--root <dir>` defaults to cwd. `--fix` opts into reconciling a
 * desynced `workflowGate` to the last evidence-backed gate.
 *
 * Exit: 0 when the memory pipeline is healthy AND the gate is evidence-backed
 * (or was reconciled by `--fix`); 1 when a memory stage looks broken or the
 * gate is desynced and left unreconciled.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  const root = resolve(args.get('root') ?? process.cwd());
  const fix = args.get('fix') === 'true';

  const diagnosis = await diagnoseMemory(root);

  const { consistency: gateConsistency, fixed: gateFixed } =
    await runGateConsistency(root, fix);

  // DN-1: domain doctor checks are best-effort — a missing/invalid config is
  // not this command's concern (the loader and gate-guard already surface
  // that); skip domain checks silently rather than failing the whole run.
  const configResult = loadDevmateConfig(resolve(root, CONFIG_PATH));
  const domainWarnings = configResult.ok
    ? checkDomainConfig(root, configResult.config.domains ?? [])
    : [];

  const gateOk = gateConsistency === null || gateConsistency.ok;
  const ok = diagnosis.ok && gateOk;

  await writeResult(
    resolve(root, '.devmate/state/memory-doctor-result.json'),
    { ...diagnosis, domainWarnings, gateConsistency, gateFixed },
  );

  // Compact machine-readable summary on stdout (never ledger contents).
  process.stdout.write(
    `${JSON.stringify({
      ok,
      firstBrokenStage: diagnosis.firstBrokenStage,
      collection: diagnosis.collection,
      promotion: diagnosis.promotion,
      render: diagnosis.render,
      domainWarnings,
      gateConsistency: gateConsistency
        ? {
            ok: gateConsistency.ok,
            status: gateConsistency.status,
            gate: gateConsistency.gate,
            evidenceBackedGate: gateConsistency.evidenceBackedGate,
            divergences: gateConsistency.divergences,
          }
        : null,
      gateFixed,
    })}\n`,
  );

  // Human-readable findings on stderr.
  for (const finding of diagnosis.findings) {
    process.stderr.write(`[memory-doctor] ${finding}\n`);
  }
  for (const warning of domainWarnings) {
    process.stderr.write(`[devmate-doctor] WARNING: ${warning}\n`);
  }
  if (gateConsistency !== null) {
    for (const finding of gateConsistency.findings) {
      process.stderr.write(`[gate-consistency] ${finding}\n`);
    }
    if (gateFixed) {
      process.stderr.write(
        `[gate-consistency] reconciled workflowGate to "${gateConsistency.evidenceBackedGate}" (--fix).\n`,
      );
    } else if (!gateConsistency.ok) {
      // --fix ran but could not reconcile automatically (a backward tamper or a
      // corrupt trace: rolling the gate back would not resolve it). Say so
      // plainly so the user does not just re-run --fix into the same wall.
      if (fix) {
        process.stderr.write(
          `[gate-consistency] --fix did NOT reconcile: this divergence (${gateConsistency.divergences.join(', ')}) ` +
            `cannot be healed by a gate rollback. Resolve it from the findings above — ` +
            `treat the trace as the truth of progress, or park the task and start fresh.\n`,
        );
      } else if (gateConsistency.recommendedCommand !== null) {
        process.stderr.write(`[gate-consistency] recovery: ${gateConsistency.recommendedCommand}\n`);
      }
    }
  }

  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
