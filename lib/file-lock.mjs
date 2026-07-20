// @ts-check
import { openSync, closeSync } from 'node:fs';
import { uptime as osUptime } from 'node:os';
import { readTextFileSync, removeFileSync, renamePathSync, writeTextFileSync } from './fs-safe.mjs';

/** @typedef {import('./types.mjs').LockOpts} LockOpts */
/** @typedef {import('./types.mjs').LockResult} LockResult */
/** @typedef {{ owner: string, ts: string, startToken?: string }} LockInfo */

/**
 * Suffix appended to a state-file path to form its lock-file path.
 * Exported so tests and CI can enumerate and clean up stale lock files.
 * @type {string}
 */
export const LOCK_SUFFIX = '.lock';

/**
 * #114: default age a dead-owner lock must exceed before it is reclaimed. Well
 * above any legitimate hold (a `task.json` write is milliseconds), so the reclaim
 * path only ever fires on a genuinely orphaned lock, and PID recycling cannot
 * false-positive within the window.
 * @type {number}
 */
export const DEFAULT_STALE_RECLAIM_MS = 30000;

/**
 * #193: how far two boot tokens may differ (in seconds) and still be treated as
 * the SAME boot session. The boot token is the host's boot epoch (wall clock
 * minus `os.uptime()`); computed at two moments it can jitter by ~a second
 * (uptime rounding, minor clock adjustment), so a small tolerance avoids ever
 * mis-classifying a genuinely-live owner as recycled — the dangerous direction.
 * A real reboot shifts the boot epoch by far more (downtime + prior uptime), so
 * this margin still catches the reboot-recycled-PID case it exists for.
 * @type {number}
 */
export const RECYCLE_BOOT_TOLERANCE_SEC = 60;

/**
 * Linux per-boot UUID — a random id generated at boot and stable until reboot,
 * crucially INCLUDING across suspend/resume (unlike the uptime-derived epoch).
 * Absent on macOS/Windows, where the epoch fallback is used.
 * @type {string}
 */
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

/**
 * #206: read the host's suspend-stable boot id, or null when it is unavailable
 * (non-Linux, or unreadable). Never throws — an unreadable id just means the
 * caller falls back to the epoch token.
 * @returns {string | null}
 */
function readBootIdSync() {
  try {
    const raw = readTextFileSync(LINUX_BOOT_ID_PATH).trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * #193/#206: a boot-session token for the CURRENT host, used to distinguish a
 * process that is still the original lock owner from an unrelated process that
 * merely RECYCLED its PID across a reboot. The token is scheme-tagged so two
 * tokens are only ever compared like-with-like:
 *
 *   - `bootid:<uuid>` — the Linux per-boot UUID (`/proc/sys/kernel/random/boot_id`).
 *     Preferred where available: it is stable across **suspend/resume** and an NTP
 *     step, closing the #193-review edge where the epoch token could shift with no
 *     reboot. Two boot ids differ iff the host actually rebooted.
 *   - `epoch:<seconds>` — the boot epoch (`wallClockSeconds - os.uptime()`), the
 *     #193 fallback for macOS/Windows/unreadable-`boot_id`. Compared with the
 *     `RECYCLE_BOOT_TOLERANCE_SEC` jitter tolerance.
 *
 * A bare `<seconds>` token (written by #193, pre-#206) is read as `epoch:<seconds>`,
 * so old locks keep working. `readBootId` and `nowMs` are injectable for tests.
 * @param {number} [nowMs]  Injected wall clock (ms since epoch).
 * @param {() => (string | null)} [readBootId]  Injected boot-id reader.
 * @returns {string}
 */
export function defaultStartToken(nowMs = Date.now(), readBootId = readBootIdSync) {
  const bootId = readBootId();
  if (bootId !== null && bootId !== '') return `bootid:${bootId}`;
  return `epoch:${Math.round(nowMs / 1000 - osUptime())}`;
}

/**
 * Per-process counter making each reclaim's temp path unique, so a same-process
 * re-reclaim (or an injected constant clock) can never collide on the steal name.
 * Cross-process uniqueness comes from the owner PID in the name.
 * @type {number}
 */
let reclaimSeq = 0;

/**
 * Read the `{ owner, ts, startToken? }` diagnostics a held lock records, or null
 * when the lock file is absent, empty (the microsecond window between
 * exclusive-create and the metadata write), or unparseable. `startToken` (#193)
 * is optional — locks written before #193, or by an older devmate, simply omit
 * it and fall back to the #114 kill-probe with no recycling guard.
 * @param {string} lockPath
 * @returns {LockInfo | null}
 */
export function readLockInfo(lockPath) {
  let raw;
  try {
    raw = readTextFileSync(lockPath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.owner === 'string' && typeof parsed.ts === 'string') {
      /** @type {LockInfo} */
      const info = { owner: parsed.owner, ts: parsed.ts };
      const boot = parsed.startToken;
      if (typeof boot === 'string') info.startToken = boot;
      return info;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * @typedef {{ scheme: 'bootid', id: string } | { scheme: 'epoch', seconds: number }} ParsedToken
 */

/**
 * Parse a boot token into its scheme + value, or null when unparseable (#206).
 * Accepts `bootid:<uuid>`, `epoch:<seconds>`, and a bare `<seconds>` (the #193
 * pre-#206 format, read as epoch). #193 review: a blank/negative/non-integer
 * epoch is garbage — `Number('')`/`Number('  ')` are `0` (1970) — so every such
 * case returns null → fail-closed (treated as unknown, never recycled).
 * @param {unknown} raw
 * @returns {ParsedToken | null}
 */
function parseBootToken(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.startsWith('bootid:')) {
    const id = raw.slice('bootid:'.length);
    return id === '' ? null : { scheme: 'bootid', id };
  }
  const epochStr = raw.startsWith('epoch:') ? raw.slice('epoch:'.length) : raw;
  if (!/^\d+$/.test(epochStr)) return null;
  const seconds = Number(epochStr);
  return Number.isFinite(seconds) ? { scheme: 'epoch', seconds } : null;
}

/**
 * #193/#206: decide whether an owner that the kill-probe reports ALIVE is in fact
 * an unrelated process that recycled the recorded PID. True only when we are
 * CONFIDENT: the owner is a real PID, both tokens parse to the SAME scheme, and
 * they indicate different boots — a distinct `bootid` UUID, or `epoch` values more
 * than the tolerance apart. Every uncertain case — a non-PID owner, a
 * missing/blank/unparseable token, mismatched schemes, or epochs within tolerance
 * — returns false, so the guard never reclaims a lock it cannot prove was recycled
 * (fail-closed, matching the rest of the stale path).
 * @param {LockInfo} info
 * @param {string} currentStartToken
 * @returns {boolean}
 */
function ownerLooksRecycled(info, currentStartToken) {
  const pid = Number(info.owner);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const stored = parseBootToken(info.startToken);
  const current = parseBootToken(currentStartToken);
  if (stored === null || current === null) return false;
  if (stored.scheme !== current.scheme) return false; // can't compare like-with-like
  if (stored.scheme === 'bootid' && current.scheme === 'bootid') {
    // A different per-boot UUID means the host rebooted — the live PID is a
    // recycled, unrelated process. Strict equality (a boot id is a public value,
    // and `.id` is not flagged by the secret-comparison lint the way a
    // token-named field is).
    return stored.id !== current.id;
  }
  if (stored.scheme === 'epoch' && current.scheme === 'epoch') {
    return Math.abs(current.seconds - stored.seconds) > RECYCLE_BOOT_TOLERANCE_SEC;
  }
  return false;
}

/**
 * Default owner-liveness probe. When `owner` is a positive integer PID, a
 * `process.kill(pid, 0)` decides existence: it succeeds for a live process,
 * throws `EPERM` for a process we may not signal but which EXISTS (still alive),
 * and throws `ESRCH` for a dead one. A non-PID owner label cannot be probed, so
 * it is reported alive — an unprovable death is never reclaimed by liveness.
 * Cross-platform: `process.kill(pid, 0)` tests existence on Windows too.
 *
 * Fail-closed: ONLY a definitive `ESRCH` (no such process) counts as dead. Any
 * other outcome — `EPERM`, an unexpected errno, or a non-Error throw with no
 * code — is treated as alive, so an ambiguous probe failure never reclaims a lock
 * that might still be held.
 * @param {string} owner
 * @returns {boolean}
 */
export function defaultIsOwnerAlive(owner) {
  const pid = Number(owner);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {unknown} */ err) {
    const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined;
    return code !== 'ESRCH';
  }
}

/**
 * A lock is stale — reclaimable — only when it is older than the reclaim bound
 * AND its recorded owner is effectively dead. "Dead" is either a definitive
 * kill-probe death (#114) OR (#193) an owner the probe reports alive but whose
 * boot token proves it is a different process that recycled the PID across a
 * reboot. Requiring the age bound keeps a just-created lock (any owner) untouched.
 * @param {LockInfo | null} info
 * @param {number} nowMs
 * @param {number} staleReclaimMs
 * @param {(owner: string) => boolean} isOwnerAlive
 * @param {string} currentStartToken
 * @returns {boolean}
 */
function isLockStale(info, nowMs, staleReclaimMs, isOwnerAlive, currentStartToken) {
  if (info === null) return false;
  const startedMs = Date.parse(info.ts);
  if (Number.isNaN(startedMs)) return false;
  const ageMs = nowMs - startedMs;
  if (ageMs < staleReclaimMs) return false;
  // Fail-closed on a throwing probe: an owner whose liveness we cannot determine
  // is assumed ALIVE, so a probe failure never reclaims a lock that might be held.
  let alive;
  try {
    alive = isOwnerAlive(info.owner);
  } catch {
    alive = true;
  }
  if (!alive) return true;
  // #193: the probe says alive, but a recycled PID (reused across a reboot by an
  // unrelated live process) also probes alive and would wedge recovery exactly as
  // before #114. A boot-token mismatch proves the live PID is NOT the original
  // owner, so the orphan can be reclaimed. Only fires when confidently recycled.
  return ownerLooksRecycled(info, currentStartToken);
}

/**
 * Acquire an exclusive file lock at `lockPath`, run `fn`, then release the lock.
 * Uses O_EXCL (exclusive creation) for cross-platform mutual exclusion.
 *
 * #114: a lock left behind by a process that died mid-hold no longer wedges the
 * workflow forever. While waiting, a held lock whose recorded owner is dead AND
 * older than `staleReclaimMs` is reclaimed (deleted) and re-acquired; a live
 * owner's lock is never reclaimed, and on timeout the error names the owner and
 * the recovery action.
 * @param {string} lockPath
 * @param {() => unknown | Promise<unknown>} fn
 * @param {LockOpts} [opts]
 * @returns {Promise<LockResult>}
 */
export async function withFileLock(lockPath, fn, opts) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const retryIntervalMs = opts?.retryIntervalMs ?? 50;
  const owner = opts?.owner ?? String(process.pid);
  const staleReclaimMs = opts?.staleReclaimMs ?? DEFAULT_STALE_RECLAIM_MS;
  const now = opts?.now ?? Date.now;
  const isOwnerAlive = opts?.isOwnerAlive ?? defaultIsOwnerAlive;
  // #193: the current host's boot-session token, recorded alongside the owner and
  // compared during reclaim to unmask a recycled PID (see ownerLooksRecycled).
  // Computed ONCE per acquisition (review): the boot epoch is invariant within a
  // boot, so a single value is both correct and deterministic — an injected or
  // clock-derived `startTokenOf` cannot yield an inconsistent stale-check vs the
  // token written into the lock.
  const startTokenOf = opts?.startTokenOf ?? (() => defaultStartToken(now()));
  const bootToken = startTokenOf();

  const deadline = now() + timeoutMs;
  let fd = -1;

  // Attempt to acquire the lock by exclusive file creation.
  while (true) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- O_EXCL exclusive-create IS the lock-acquisition semantics; the facade deliberately does not expose open flags. lockPath is a caller-supplied state-file path plus the constant LOCK_SUFFIX ('.lock'), e.g. .devmate/state/task.json.lock.
      fd = openSync(lockPath, 'wx');
      break; // acquired
    } catch (/** @type {unknown} */ err) {
      const code = err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        // #114: reclaim a lock whose owner is dead and whose age exceeds the
        // bound, then retry immediately. The steal MUST be atomic: a bare
        // unlink-by-name is a TOCTOU — two waiters could both decide to reclaim,
        // and the second's unlink would land on the FIRST's freshly re-acquired
        // lock, so both would run under "the" lock (a lost update, the very class
        // this exists to close). Instead, rename the stale inode to a unique path:
        // only ONE process can rename a given inode, so the loser's rename fails
        // and it re-loops. Whoever wins the rename then races openSync('wx')
        // cleanly, and deletes only the inode it stole.
        const info = readLockInfo(lockPath);
        if (isLockStale(info, now(), staleReclaimMs, isOwnerAlive, bootToken)) {
          const stolen = `${lockPath}.reclaim.${owner}.${reclaimSeq++}`;
          try {
            renamePathSync(lockPath, stolen);
          } catch {
            // Lost the steal (another reclaimer moved it, or it vanished) — retry.
            continue;
          }
          try {
            removeFileSync(stolen);
          } catch {
            // Best-effort: a leftover stolen file is harmless (unique name, never
            // read); the lock itself is already freed.
          }
          continue;
        }
        if (now() >= deadline) {
          const held = info !== null ? ` (held by owner ${info.owner} since ${info.ts}` +
            `; if that process is gone, delete ${lockPath} to recover)` : '';
          return {
            acquired: false,
            error: `Lock timeout after ${timeoutMs}ms: ${lockPath}${held}`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        continue;
      }
      return {
        acquired: false,
        error: `Lock acquire error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Write owner + timestamp + boot token into lock file for diagnostics and
  // stale-reclaim. The boot token (#193) lets a later reclaimer distinguish this
  // owner from an unrelated process that recycles the PID across a reboot.
  try {
    writeTextFileSync(
      lockPath,
      JSON.stringify({ owner, ts: new Date(now()).toISOString(), startToken: bootToken }) + '\n',
    );
  } catch {
    // Non-fatal diagnostics write.
  }

  // Close the fd; we only needed exclusive creation via O_EXCL.
  try {
    closeSync(fd);
  } catch {
    // ignore
  }

  // Run fn; capture error so we can release the lock before re-throwing.
  let fnError = /** @type {unknown} */ (null);
  let result = /** @type {unknown} */ (undefined);
  try {
    result = await fn();
  } catch (/** @type {unknown} */ err) {
    fnError = err;
  }

  // Release lock file.
  try {
    removeFileSync(lockPath);
  } catch (/** @type {unknown} */ unlinkErr) {
    process.stderr.write(
      `[devmate] Warning: failed to unlink lock file ${lockPath}: ${
        unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
      }\n`
    );
  }

  if (fnError !== null) {
    throw fnError;
  }

  return { acquired: true, value: result };
}
