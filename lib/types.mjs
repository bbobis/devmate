// @ts-check

/**
 * Official VS Code Copilot hook event names.
 * Source: https://code.visualstudio.com/docs/copilot/customization/hooks
 * @typedef {'SessionStart'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'|'PreCompact'|'SubagentStart'|'SubagentStop'|'Stop'} HookEvent
 */

/**
 * A single hook entry in the manifest.
 * @typedef {Object} HookEntry
 * @property {"command"} type         Must always be the string literal "command".
 * @property {HookEvent} event        The hook event this entry fires on.
 * @property {string} command         Path to the .mjs hook entrypoint.
 * @property {string} [windows]       Windows form of `command`. Every entry in
 *                                    hooks/hooks.json carries one, and the type
 *                                    did not admit it existed — so anything
 *                                    reasoning about the manifest saw only half
 *                                    the registrations, and a Windows-only drift
 *                                    was untypeable (#48 was exactly that).
 * @property {number} [timeout]       Seconds before the host kills the command.
 * @property {string} [matcher]       Accepted for compatibility but IGNORED at runtime.
 *                                    The hook runs on ALL events of its type; filter
 *                                    internally by reading `tool_name`/`hook_event_name`
 *                                    from stdin JSON.
 */

/**
 * The full hook manifest as parsed from hooks/hooks.json.
 * @typedef {Object} HookManifest
 * @property {Record<string, HookEntry[]>} hooks  Keyed by HookEvent name.
 * @property {number} schemaVersion
 */

/**
 * A single entry in the artifact allowlist.
 * @typedef {Object} AllowlistEntry
 * @property {string} path        Repo-relative path (glob patterns allowed).
 * @property {'agent-loadable'|'human-only'|'generated'|'archive'} role  Role classification.
 * @property {string} [notes]     Optional rationale.
 */

/**
 * The parsed result of loading docs/artifact-allowlist.json.
 * @typedef {Object} AllowlistResult
 * @property {AllowlistEntry[]} entries
 * @property {number} schemaVersion
 */

/**
 * Capability type discriminator.
 * @typedef {'agent'|'command'|'skill'|'hook'|'script'} CapabilityType
 */

/**
 * A single capability entry in the registry.
 * @typedef {Object} CapabilityEntry
 * @property {string} id              Unique kebab-case identifier.
 * @property {CapabilityType} type
 * @property {string} name            Human-facing display name.
 * @property {string} description     One-sentence description.
 * @property {string} invocationPath  File path or command string.
 * @property {'auto-registered'|'agent-invoked'|'user-invoked'} invocation
 * @property {string[]} [tags]
 */

/**
 * The full capability registry as parsed from docs/capability-registry.json.
 * @typedef {Object} CapabilityRegistry
 * @property {CapabilityEntry[]} capabilities
 * @property {number} schemaVersion
 * @property {string} generatedAt     ISO 8601 timestamp of last generation.
 */

/**
 * Per-file token/line budget configuration entry.
 * @typedef {Object} FileBudget
 * @property {string} path               Repo-relative path (glob patterns allowed).
 * @property {number} maxLines           Hard line-count limit.
 * @property {number} [maxTokensEstimate] Soft estimated-token limit (chars / 4).
 * @property {string} [notes]
 */

/**
 * Result of checking a single file against its budget.
 * @typedef {Object} BudgetCheckResult
 * @property {string} path
 * @property {boolean} passed
 * @property {number} actualLines
 * @property {number} [actualTokensEstimate]
 * @property {string[]} violations        Human-readable violation messages.
 */

/**
 * The kind of platform claim a docs line asserts.
 * @typedef {'hook-event'|'config-key'|'state-name'|'gate-name'|'count'|'enforcement'} DocsClaimType
 */

/**
 * Result of the token-budget eval (E9-21).
 * @typedef {Object} TokenBudgetEvalResult
 * @property {boolean} budgetEventsFired      A budget_warning fired when a threshold was crossed.
 * @property {boolean} resumeSufficient       canResumeFromCompaction passed post-compaction.
 * @property {boolean} activeContextBounded    Post-compaction estimated tokens <= class threshold.
 * @property {boolean} ledgerPromoted          Active ledger promoted to the repo ledger.
 * @property {number}  score                   Count of the above that hold.
 */

/**
 * Result of the trajectory eval over one trace (E9-23).
 * @typedef {Object} TrajectoryEvalResult
 * @property {boolean} noEditBeforeImpl     No source-edit event before impl-started.
 * @property {boolean} legalTransitionSeq   Every gate_transition is legal per the unified table.
 * @property {boolean} budgetEventsPresent  budget_warning present when a threshold was crossed.
 * @property {boolean} boundedToolCalls     Tool-call count under the cap.
 * @property {number}  score                Count of the above that hold.
 */

/**
 * Judge verdict per issue (opt-in LLM-judge tier, E9-25).
 * @typedef {Object} JudgeVerdict
 * @property {string} issueId
 * @property {boolean|null} claimsTrue     null = judge unavailable/unknown.
 * @property {boolean|null} acTestable
 * @property {string} rationale
 */

/**
 * A committed model-routing baseline for one budget class (E9-22).
 * @typedef {Object} RoutingBaseline
 * @property {BudgetClass} budgetClass
 * @property {string} recordedAt        ISO-8601.
 * @property {string} taskSetHash       Hash of the fixed task set used.
 * @property {number} taskCount         Tasks in the fixed set for this class.
 * @property {{ costUsd: number, qualityScore: number }} metrics
 */

/**
 * Persisted proof a verify run passed, consumed by the pass-verification gate.
 * @typedef {Object} VerifyResultArtifact
 * @property {boolean} passed
 * @property {string}  digest         Short summary of the verify output.
 * @property {string}  fullOutputPath Capped full-output artifact path.
 * @property {string}  completedAt    ISO-8601 timestamp.
 * @property {string}  specDigest     SHA-256 of the approved spec this verifies.
 * @property {string}  [taskId]       Owning task id, so the gate can refuse a
 *                                    prior task's stale verify evidence.
 */

/**
 * Marker written on a critical session-budget breach; cleared by compaction.
 * @typedef {Object} BudgetCriticalMarker
 * @property {string} at       ISO-8601 timestamp of the breach.
 * @property {string} field    Budget dimension that crossed.
 * @property {number} current  Measured estimated tokens.
 * @property {number} limit    Critical threshold crossed.
 */

/**
 * A single typed claim extracted from a docs file.
 * @typedef {Object} DocsClaim
 * @property {string} file           Source file path.
 * @property {number} line           1-based line number where the claim appears.
 * @property {DocsClaimType} claimType
 * @property {string} value          The claimed value (e.g. event name, key name).
 */

/**
 * A drift violation: a docs claim that does not match ground truth.
 * @typedef {Object} DriftViolation
 * @property {DocsClaim} claim
 * @property {string} reason         Why it does not match ground truth.
 */

/**
 * Workflow lane: feature | bug | chore.
 * @typedef {'feature'|'bug'|'chore'} Lane
 */

/**
 * Workflow gate names for numbered pipeline checkpoints. `parked` (task paused
 * with a persisted resume pointer recording the gate to return to) and
 * `abandoned` (deliberate terminal: the task was dropped, not completed) are
 * the E10-05 steering gates.
 * @typedef {'no-lane'|'lane-set'|'discovery-done'|'grill-done'|'plan-done'|'plan-approved'|'spec-draft'|'spec-approved'|'spec-invalidated'|'impl-started'|'verification-passed'|'pr-ready'|'done'|'parked'|'abandoned'} WorkflowGate
 */

/**
 * Issue 111: Structured error persisted when spec-approved continuation fails.
 * Allows the approval to remain durable while the human retries.
 * @typedef {Object} ContinuationError
 * @property {string} at        Gate name where continuation failed (e.g. "spec-approved").
 * @property {string} message   Error message from the failed continuation attempt.
 * @property {string} ts        ISO 8601 timestamp of the failure.
 * @property {string} recovery  Canonical phrase for the human to type to retry.
 */

/**
 * Canonical per-task workflow state.
 * @typedef {Object} TaskState
 * @property {string}   taskId           Unique task identifier (slug or issue number).
 * @property {Lane}     lane             Workflow lane: feature | bug | chore.
 * @property {WorkflowGate} workflowGate Current workflow gate.
 * @property {Record<string, string>} artifactHashes  SHA-256 digests keyed by relative path.
 * @property {string|null} preImplStash  Git stash ref captured before implementation, or null.
 * @property {number}   currentStep      Zero-based step index within the current gate.
 * @property {number}   budget           Remaining step budget (decremented by loop engine).
 * @property {string[]} [specFiles]      E11/P1-4: deterministic file list extracted from the approved
 *                                       plan and persisted by spec-writer so feature continuation does
 *                                       not need to parse markdown fallback.
 * @property {string[]} [acceptanceCriteria] Ordered global acceptance-criteria texts persisted by
 *                                       spec-writer. Index+1 is the stable per-AC id (`impl-AC{n}`,
 *                                       equal to the `TC-00{n}` test row), used to record and resume
 *                                       per-AC implementation progress in the canonical trace.
 * @property {string}   [backendReadyStaleSince] E5-4: ISO 8601 timestamp set when the
 *                                       backend-ready gate goes stale after a passing check.
 * @property {ChoreException[]} [approvedExceptions] E5-3: narrow source-code exceptions
 *                                       approved for the current chore lane.
 * @property {TddGuardState} [tddGuard]   E12-2: persisted TDD enforcement state for the current task.
 * @property {TddScenario[]} [testPlan]    E15-1: declared test scenarios whose test files
 *                                       must exist before task completion.
 * @property {ActiveAgentEntry[]} [activeAgents] Issue 93 — the sub-agents currently in flight, stamped from
 *                                       the host's `agent_type`/`agent_id` at SubagentStart and removed at
 *                                       SubagentStop (hooks/subagent-budget-guard.mjs). The gate-guard reads
 *                                       it back as the `activeAgent` identity for the session-artifact rule —
 *                                       PreToolUse carries no agent name of its own. Absent/empty means no
 *                                       sub-agent is in flight; reconciled to empty at SessionStart alongside
 *                                       activeSubagents, since no sub-agent survives a session boundary.
 * @property {number}   [activeSubagents] E13-4: count of currently running sub-agents. Tracked by the subagent-budget-guard SubagentStart and SubagentStop hooks. Absent on tasks that predate E13-4 — readers treat absent as 0. DN-6: a nonzero value is reconciled to 0 at SessionStart, since a fresh session implies no prior sub-agent survives (a stale count would otherwise leak across a hard interrupt).
 * @property {string[]} [activeDomains]  DN-2: ids of the business domains the domain resolver
 *                                       matched for this task (ranked order, capped at
 *                                       DOMAIN_MATCH_TOP_N). Written at the hook boundary
 *                                       alongside the domain-context state file. Readers treat
 *                                       absent as none — same convention as activeSubagents.
 * @property {OutputContract} [outputContract] Persisted budget contract (E4-1); absent on legacy state.
 * @property {EvidencePack}   [evidencePack]   Just-in-time evidence pointers (E4-2); populated by E9-19.
 * @property {string}   [sessionPath]    E4-6: path of the loaded session markdown, if a session keeps
 *                                       one. Counted by the session budget; archived by compaction.
 *                                       No producer ships today — absent means 0 bytes, honestly.
 * @property {string|null} [lastToolOutputPath] E4-6: pointer to the most recent recorded tool output.
 *                                       Counted by the session budget; nulled by compaction.
 * @property {string}   [traceFile]      E4-6: explicit trace path override. Absent means the canonical
 *                                       per-task path derived from taskId.
 * @property {string[]} [loadedSkills]   E4-6: ids of skill stubs currently loaded. Recorded for
 *                                       messaging; does not add to the token total.
 * @property {ContinuationError} [continuationError] Issue 111: Error persisted after spec-approved continuation fails. Cleared on retry.
 * @property {number}   [stateVersion]   Issue 112: monotonic optimistic-concurrency token, bumped on every
 *                                       write committed through {@link mutateTaskStateUnderLock}. Absent
 *                                       on legacy/bootstrap state — readers treat absent as 0. A snapshot
 *                                       taken outside the lock carries the version it was read at, so a
 *                                       stale writer that pins `expectedVersion` is refused with a
 *                                       structured conflict rather than clobbering newer state.
 * @property {number}   schemaVersion    Must equal 1 for this version.
 */

/**
 * #112: one append-only record of a state mutation committed through
 * {@link mutateTaskStateUnderLock}, written to the per-task transition log. The
 * audit trail the atomicity guarantee rests on: every version bump leaves a row
 * whose `fromVersion`/`toVersion` and `fromGate`/`toGate` reconstruct the exact
 * ordering of writes, even across interleaved sessions.
 *
 * `branchId` is the isolation key. Until forked-session branching lands (#113)
 * it equals `taskId`; the field exists now so the log format does not change
 * when branches arrive.
 * @typedef {Object} StateTransitionRecord
 * @property {string}       taskId       Task whose state moved.
 * @property {string}       branchId     Branch key (equals `taskId` pre-#113).
 * @property {number}       fromVersion  Version read inside the lock before the write.
 * @property {number}       toVersion    Version stamped by the committed write (`fromVersion + 1`).
 * @property {string}       event        Caller-supplied label for what drove the write (default `mutate`).
 * @property {WorkflowGate} fromGate     Gate before the mutation.
 * @property {WorkflowGate} toGate       Gate after the mutation (equals `fromGate` when only data changed).
 * @property {string}       ts           ISO-8601 timestamp of the commit.
 */

/**
 * #112: outcome of a {@link mutateTaskStateUnderLock} call. A best-effort,
 * never-throwing result: a lost read (no task / corrupt state), a mutator that
 * fails validation, a lock failure, and an optimistic-concurrency conflict are
 * all reported here rather than thrown.
 *
 * `conflict` is set ONLY when the caller pinned `expectedVersion` and the fresh
 * in-lock version differed — the deterministic stale-write refusal. On success,
 * `written` is false when the mutator returned `null` (nothing to change) and
 * `version` is the version now on disk.
 * @typedef {{ ok: true, written: boolean, version: number }
 *   | { ok: false, error: string, conflict?: boolean, currentVersion?: number, expectedVersion?: number }
 * } MutateResult
 */

/**
 * E12-2: persisted TDD enforcement state for the current task. Lives under
 * `TaskState.tddGuard` and is mutated by the gate-guard PreToolUse hook and
 * by the approval listener when the human grants the `approve no-tdd` override.
 * @typedef {Object} TddGuardState
 * @property {boolean} testFileWritten           True if a test file has been written in this task.
 * @property {number}  consecutiveNonTestWrites  Count of consecutive non-test source writes without a prior test write.
 * @property {boolean} overrideGranted           True if the human ran "approve no-tdd".
 * @property {string}  [overrideReason]          Justification provided with the override.
 */

/**
 * A single test scenario declared in the spec.
 * @typedef {Object} TddScenario
 * @property {string} id           Unique scenario ID (for example "TC-001").
 * @property {string} description  One-line human description of this scenario.
 * @property {1|2|3}  tier         Test tier signal (1=unit, 2=integration, 3=e2e).
 * @property {string} testFile     Repo-relative path to the test file.
 * @property {string} runCommand   Human instruction for running the test.
 */

/**
 * E5-3: A narrow, approved source-code exception inside the chore lane.
 * @typedef {Object} ChoreException
 * @property {string}   path          File path (or path prefix) the exception applies to.
 * @property {string}   description   What application-logic change is approved.
 * @property {string}   approvedBy    Gate phrase that granted it (starts with 'approved exception:').
 * @property {string}   grantedAt     ISO 8601 timestamp.
 */

/**
 * E5-7: A non-destructive rollback plan, built without running any mutating git.
 * @typedef {Object} RollbackPlan
 * @property {string}    stashRef       Git stash ref to restore (e.g. 'stash@{0}').
 * @property {string}    targetCommit   Commit SHA to reset to (stash's base commit).
 * @property {string[]}  dirtyFiles     Unstaged/uncommitted files detected.
 * @property {boolean}   hasConflicts   Whether a stash pop is likely to conflict.
 * @property {string}    drySummary     Human-readable dry-run description.
 * @property {string[]}  recoveryHints  Ordered hints to recover if rollback fails.
 */

/**
 * E5-7: Result of executing (or dry-running) a rollback.
 * @typedef {Object} RollbackResult
 * @property {boolean}  success
 * @property {string}   message
 * @property {string[]} recoveryHints  Non-empty only on failure.
 */

/**
 * E5-6: Where a `/devmate-learn` invocation routes.
 * @typedef {'help'|'pattern-authoring'} LearnRoute
 */

/**
 * E5-6: A recognized pattern authored into `.devmate/patterns/`.
 * @typedef {Object} Pattern
 * @property {string}   id        Slug (e.g. 'use-atomic-writes').
 * @property {string}   title
 * @property {string}   body      Pattern content (Markdown).
 * @property {string}   filePath  Path under `.devmate/patterns/`.
 * @property {string}   createdAt ISO 8601 timestamp.
 */

/**
 * E5-6: Explicit user approval for a pending pattern write.
 * @typedef {Object} PatternApproval
 * @property {string}  patternId
 * @property {string}  approvedBy  Must start with the phrase 'approve pattern:'.
 * @property {string}  approvedAt  ISO 8601 timestamp.
 */

/**
 * E5-5: One PR-readiness check outcome.
 * @typedef {Object} PrReadyCheck
 * @property {string}   name    Human-readable check name.
 * @property {boolean}  passed
 * @property {string}   detail  One-sentence pass/fail explanation.
 */

/**
 * E5-5: Full PR-readiness evaluation result.
 * @typedef {Object} PrReadyResult
 * @property {boolean}        ready       True only when all checks pass.
 * @property {PrReadyCheck[]} checks      Individual check outcomes.
 * @property {Lane}          lane        feature | bug | chore.
 * @property {string}        taskId
 * @property {string}        evaluatedAt ISO 8601 timestamp.
 */

/**
 * E5-5: Compact, token-lean summary of trace state consumed by the PR-ready
 * evaluator. Produced by `read-trace` (E3-6 / E6-2) — NOT raw workflow docs.
 * @typedef {Object} TraceSummary
 * @property {string}   lastCompletedStep
 * @property {string[]} openBlockers
 * @property {string}   currentGate
 */

/**
 * E5-4: A single backend health probe. Stack-agnostic — no Spring/actuator assumption.
 * @typedef {Object} HealthPredicate
 * @property {string}   url            HTTP URL to probe.
 * @property {number}   [statusCode]   Expected HTTP status (default 200).
 * @property {string}   [bodyContains] Substring that must appear in the response body.
 * @property {number}   [timeoutMs]    Per-request timeout in ms (default 5000).
 */

/**
 * E5-4: Outcome of running all configured health predicates.
 * @typedef {Object} BackendReadyResult
 * @property {boolean}  ready
 * @property {string}   reason            Human-readable outcome (pass or first failure detail).
 * @property {string}   checkedAt         ISO 8601 timestamp.
 * @property {string[]} failedPredicates  URLs of any failed predicates.
 */

/**
 * Result of reading or validating a TaskState.
 * @typedef {{ ok: true, state: TaskState } | { ok: false, errors: string[] }} StateResult
 */

/**
 * Named events that drive gate transitions. `draft-spec` (HITL-2) is the
 * feature lane's only legal move out of plan-approved — it enters the
 * spec-draft human review gate, so implementation can never be reached
 * without traversing spec approval. The E10-05 steering events map
 * mid-workflow scope changes to legal edges: `revise-scope` (impl-started
 * re-enters the spec loop), `re-plan` (impl-started re-enters planning),
 * `new-requirements` (spec-draft steps back to grill-done), `park` (any
 * in-flight gate pauses to parked), `resume` (parked returns to the recorded
 * gate), and `abandon` (deliberate terminal).
 * @typedef {'set-lane'|'finish-discovery'|'finish-grill'|'finish-plan'|'present-plan'|'approve-plan'|'draft-spec'|'start-impl'|'pass-verification'|'mark-pr-ready'|'complete'|'revise-scope'|'re-plan'|'new-requirements'|'park'|'resume'|'abandon'} GateEvent
 */

/**
 * Result of a gate transition attempt.
 * @typedef {Object} TransitionResult
 * @property {boolean}      ok       True if transition was applied.
 * @property {TaskState}    [state]  Updated state (only when ok=true).
 * @property {string}       [error]  User-actionable message (only when ok=false).
 * @property {WorkflowGate} [from]   Gate before transition.
 * @property {WorkflowGate} [to]     Gate after transition.
 */

/**
 * E10-05: persisted resume pointer written before a task is parked. The
 * `parked` gate precondition refuses a park without it, and the resume
 * transition reads it to resolve which gate to return to — so a park/resume
 * round-trip always continues the same task at the recorded gate.
 * Canonical location: `.devmate/state/resume-pointer.json`.
 * @typedef {Object} ResumePointer
 * @property {string}       taskId    Task this pointer belongs to.
 * @property {WorkflowGate} gate      Gate the task was parked from (resume target).
 * @property {string}       parkedAt  ISO-8601 timestamp the park was recorded.
 * @property {string}       [note]    Optional human note on why the task was parked.
 */

/**
 * E10-05: captured scope-change note required by the `revise-scope` steering
 * event, so a mid-implementation re-scope always records what changed before
 * the spec loop re-runs. Canonical location: `.devmate/state/scope-change.json`.
 * @typedef {Object} ScopeChangeNote
 * @property {string} taskId      Task this note belongs to.
 * @property {string} note        What changed about the scope (non-empty).
 * @property {string} capturedAt  ISO-8601 timestamp the note was captured.
 */

/**
 * Canonical named dependency gates.
 * @typedef {'backend-unit-pass'|'backend-ready'|'frontend-unit-pass'|'all-tests-pass'} DepGateName
 */

/**
 * Dependency gate status values.
 * @typedef {'pending'|'pass'|'fail'|'skipped'} DepGateStatus
 */

/**
 * A single dependency gate entry stored in gates.json.
 * @typedef {Object} DepGateEntry
 * @property {DepGateName}   name
 * @property {DepGateStatus} status
 * @property {string}        updatedAt  ISO-8601 timestamp.
 * @property {string}        [reason]   Optional human note.
 */

/**
 * The full dependency gates map keyed by gate name.
 * @typedef {Record<DepGateName, DepGateEntry>} DepGates
 */

/**
 * Options for withFileLock and acquireLock.
 * @typedef {Object} LockOpts
 * @property {number} [timeoutMs=5000]      Max wait time before giving up.
 * @property {number} [retryIntervalMs=50]  Poll interval while waiting.
 * @property {string} [owner]               Label written into the lock file for diagnostics (defaults to the PID).
 * @property {number} [staleReclaimMs=30000] Issue 114: a lock whose recorded owner is dead AND older than this
 *                                       bound is reclaimed instead of waited on. A live-owner lock is never
 *                                       reclaimed regardless of age.
 * @property {() => number} [now]        Issue 114: injectable clock (ms) for the deadline and stale-age math — deterministic tests. Must be MONOTONIC: a constant clock never reaches the deadline, so the wait loop would spin until the lock frees or is reclaimed.
 * @property {(owner: string) => boolean} [isOwnerAlive] Issue 114: injectable liveness check for the recorded owner;
 *                                       defaults to a PID-liveness probe. A non-PID owner label is treated as alive
 *                                       (unprovable death ⇒ never reclaimed by liveness).
 * @property {() => string} [startTokenOf] Issue 193: injectable boot-session token source (defaults to the host boot
 *                                       epoch from `os.uptime()`). Written into the lock and compared at reclaim so an
 *                                       "alive" PID recycled across a reboot is unmasked and reclaimed.
 */

/**
 * Result of a withFileLock call.
 * Either the lock was acquired and fn ran (value is the fn return value),
 * or the lock could not be acquired (error is a human-readable reason).
 * @typedef {{ acquired: true, value: unknown } | { acquired: false, error: string }} LockResult
 */

// ---- E3-1: JSONL mutex lock types ----

/**
 * Handle returned by acquireLock. Pass to releaseLock to free the sentinel.
 * @typedef {Object} LockHandle
 * @property {string}   lockPath  Absolute path to the `.lock` sentinel file.
 * @property {Function} release   Call to delete the sentinel and free the lock.
 */

/**
 * Result of an appendJsonl call.
 * @typedef {Object} AppendResult
 * @property {boolean} ok
 * @property {string}  ledgerPath
 * @property {number}  bytesWritten
 * @property {{ event: 'lock_timeout', ledgerPath: string, timeoutMs: number } | null} timeoutEntry
 *   Non-null when a timeout was emitted before failing.
 */

/**
 * An entry recorded when a gate is forced past an unsatisfied prerequisite.
 * @typedef {Object} OrderViolationEntry
 * @property {DepGateName}   gate       Gate that was blocked but forced.
 * @property {DepGateName[]} missing    Prerequisites not yet in `pass` status.
 * @property {string}        timestamp  ISO-8601 when the denial was recorded.
 * @property {boolean}       forced     Always true (written only on --force).
 */

// ---- E1-6: gate-guard types ----

/**
 * A VS Code Copilot hook stdin payload (PreToolUse / PostToolUse), plus the
 * fields devmate *derives* from it.
 *
 * The wire fields, and there are no others:
 *   `tool_name`, `tool_input`, `tool_response`, `tool_use_id`,
 *   `hook_event_name`, `cwd` (optional), `session_id`, `timestamp`,
 *   `transcript_path`.
 *
 * **No hook event carries a workspace or repo root.** That is the single fact
 * this typedef used to obscure: it declared a `workspaceRoot` marked
 * `[UNVERIFIED]` and an `agentId` marked the same, and the code read both — so
 * in production both were `undefined`, every fallback fired, and state landed in
 * `.devmate/.devmate/` under a task called `"unknown"` (#76). A typedef that
 * lists a field the host never sends is not documentation; it is a licence to
 * read it. Both are deleted. The root is *inferred*, from `cwd`, by
 * `resolveHookRoot` — the only mechanism that exists.
 *
 * @typedef {Object} HookPayload
 * @property {string}                 tool_name        VS Code wire name, e.g. 'read_file', 'replace_string_in_file', 'run_in_terminal'.
 * @property {string}                 [path]           DERIVED, not a wire field: the target path, via lib/hooks/tool-input.mjs. VS Code names it `filePath` / `dirPath` / `replacements[].filePath` / `files[]` per tool, and never `path`.
 * @property {string}                 [command]        DERIVED: the command string from `tool_input`, for shell tools.
 * @property {string[]}               [namedPaths]     DERIVED, not a wire field: every gateable path the `tool_input` names under ANY key (`namedPaths` in lib/hooks/tool-input.mjs) — how an unrecognized (MCP / extension-contributed) tool is classified. `[]` means "names no protected file" and is what lets such a tool run; ABSENT means nothing was inspected, and `isSourceEditTool` fails closed on it (#94).
 * @property {string}                 [content]        DERIVED: a capped preview of `tool_response`.
 * @property {string}                 [cwd]            Wire field, OPTIONAL. The only root-bearing value a hook receives — and in a multi-root workspace it is workspaceFolders[0], which monoroot makes the workspace's own `.devmate/` folder.
 * @property {string}                 [hook_event_name] Wire field, e.g. 'PostToolUse'.
 * @property {string|Record<string,unknown>} [tool_input]  Wire field: raw tool params — but NOT always an object. The agent log elides it to the literal string "..." for some tools (every edit tool, and `runSubagent`). Typing it as a bare Record invited unsafe property access on a value that can be a string, which is how `tool_input.agentName` came to be read from something that may never have been there. Narrow it before reading a key: the path lives behind `firstToolInputPath` (lib/hooks/tool-input.mjs), and a subagent's identity behind `extractAgentResult` (lib/hooks/agent-result.mjs).
 * @property {string|Record<string,unknown>} [tool_response]  Wire field: raw tool output. For `runSubagent` this is a plain STRING — the agent's final chat text, i.e. prose followed by its embedded JSON contract — NOT a structured object and NOT a `{ content }` wrapper (captured/posttooluse.run-subagent.json). Code that did `JSON.parse(tool_response)` therefore threw on every real dispatch; use `extractAgentResult` from lib/hooks/agent-result.mjs.
 * @property {string}                 [session_id]     Wire field: the host's session identifier, present on every captured payload. The only unique, host-supplied id available at SessionStart, so it is what a bootstrapped taskId is derived from.
 * @property {string}                 [tool_use_id]    Wire field: unique per tool call, present on every captured payload. Keys a persisted worker return, so a parallel fan-out of K same-named agents does not overwrite itself.
 * @property {string}                 [agentName]      DERIVED, [UNVERIFIED]: the target agent of a `runSubagent` call, read from `tool_input.agentName`. That is a field of the *tool's* input schema, not of the hook payload, and the log elides `runSubagent`'s tool_input, so no capture can confirm it — prefer the `agentName` inside the agent's own returned contract. The structural gate is the SubagentStart guard, which reads the verified `agent_type`.
 */

/**
 * The gate-guard's INTERNAL verdict. This is **not** the wire format: VS Code
 * honors a PreToolUse decision only under
 * `hookSpecificOutput.permissionDecision`. Serialize with `toPreToolUseOutput`
 * from lib/gate-guard-core.mjs before writing to stdout — emitting this shape
 * raw (as devmate did until #74) means the host ignores it and runs the tool.
 *
 * @typedef {Object} GuardDecision
 * @property {'allow'|'deny'} decision
 * @property {string} [reason]  Required when decision is 'deny'.
 */

/**
 * P06: Parsed scope.md contract — the unified edit-boundary artifact written
 * by lane producers (diagnose for bug, writeChoreScope for chore, workstream
 * partitioner for feature) and read by the gate-guard at the PostToolUse boundary.
 *
 * Schema (canonical form written to .devmate/session/{taskId}/scope.md):
 *
 *   ---
 *   lane: chore
 *   ---
 *   # Scope
 *
 *   ## Allowed paths
 *   - package.json
 *
 *   ## Allowed globs
 *   - docs\/**\/*.md
 *
 * @typedef {Object} ParsedScope
 * @property {string[]} allowedPaths  Literal file paths permitted by this scope.
 * @property {string[]} allowedGlobs  Glob patterns permitted by this scope.
 * @property {'bug'|'chore'|'feature'} lane  Originating workflow lane.
 */

/**
 * A persona entry from devmate.config.json (E10 re-spec: replaces lane-keyed ScopeEntry).
 * @typedef {Object} PersonaEntry
 * @property {string}   persona       Name of the persona (e.g. 'frontend', 'backend').
 * @property {string[]} editableGlobs  Glob patterns this persona may edit.
 * @property {string[]} [offLimitsGlobs] Glob patterns this persona must NOT edit.
 * @property {string[]} [testGlobs]   E14: persona-scoped test-file globs for PostToolUse TDD completion checks.
 * @property {string|null} [instructionFile] E13-2: relative path to a Markdown file injected as a persona context prefix at dispatch time. Null or omitted means no injection.
 * @property {string}   [repo]        B2: multi-root only — repo subdirectory (relative to repoRoot) this persona targets.
 * @property {string}   [repoPath]    B2: multi-root only — absolute path to this persona's repo, resolved by the loader as resolve(repoRoot, repo). Never present in single-root mode.
 * @property {'repo'|'fallback'} [source] B9: multi-root only — provenance stamp from the producer's merge. 'repo' = authored in a sub-repo's config; 'fallback' = synthesized by the util for an un-init'd repo.
 * @property {boolean}  [synthesized] B9: multi-root only — true when the producer invented this persona for a repo with no usable config. Pairs with source === 'fallback'.
 */

/**
 * One inferred/authored verification check. The set is variable-length — fit to
 * the codebase, not a fixed triplet. `command` is OPAQUE: it is rendered as text
 * into dispatch payloads and never auto-executed by the loop.
 * @typedef {Object} VerificationCheck
 * @property {string}  id        Stable kebab-case id, unique within checks[] (e.g. 'unit-test', 'lint', 'build').
 * @property {string}  command   Command string to run.
 * @property {string}  category  Open-ended label (conventional: unit-test | type-check | e2e | lint | format | build | audit | contract | integration | ...). NOT an enum — runtime code never hardcodes a category set.
 * @property {boolean} [optional] Advisory / non-blocking when true. Default false.
 * @property {string}  [source]  Grounding pointer (e.g. 'package.json#scripts.test'); '[UNVERIFIED]' for an ungrounded proposal.
 */

/**
 * Consumer-declared verification. `checks` is the canonical variable-length list
 * — runtime code treats every command as an opaque string and never hardcodes
 * language/tool-specific defaults.
 *
 * unitTest/typeCheck/e2e are DEPRECATED legacy input: still accepted and
 * normalized into `checks` by the loader (see lib/config/verification.mjs) for
 * backward compatibility, but no longer generated by `devmate init` nor read
 * directly by consumers.
 * @typedef {Object} VerificationConfig
 * @property {VerificationCheck[]} [checks]  Canonical inferred/authored checks.
 * @property {string} [unitTest]   @deprecated legacy — normalized to a category:'unit-test' check.
 * @property {string} [typeCheck]  @deprecated legacy — normalized to a category:'type-check' check.
 * @property {string} [e2e]        @deprecated legacy — normalized to a category:'e2e' check.
 */

/**
 * A grounded verification-command candidate discovered by the deterministic
 * init scan (lib/init/scan-verification-signals.mjs). Every candidate cites a
 * real `source` in the repo — the LLM enrichment stage selects/labels these,
 * it never invents commands.
 * @typedef {Object} VerificationCandidate
 * @property {string}  command    The command a maintainer would run (e.g. 'npm test', 'make build').
 * @property {string}  category   Best-effort category ('unknown' allowed when the scan can't classify it).
 * @property {string}  source     Grounding pointer, e.g. 'package.json#scripts.test' or 'Makefile#build'.
 * @property {number}  confidence Heuristic confidence in [0, 1] used only for deterministic ordering.
 */

/**
 * A business-domain ownership map entry from devmate.config.json (DN-1).
 * Maps a task's business vocabulary ("billing", "invoice", "refund") to the
 * file clusters and invariants of that domain. Anchors on paths/globs only —
 * no symbol-level entries (would require a compiler/AST dependency, which
 * conflicts with the zero-runtime-dep rule). Optional top-level key; absent
 * means today's behavior (no-op) for the whole domain-aware-navigation epic.
 * @typedef {Object} DomainConfig
 * @property {string}   domain          Unique id, kebab-case (e.g. 'billing').
 * @property {string[]} keywords        Business vocabulary for lexical matching (lowercase).
 * @property {string[]} globs           Repo-relative globs owning this domain's files.
 * @property {string|null} contextFile  Repo-relative path to the domain context markdown, or null. Normalized to null when omitted.
 * @property {string[]} [relatedDomains]  Ids of adjacent domains (cross-domain contracts). Normalized to [] when omitted.
 * @property {string[]} [entryPoints]     Repo-relative FILE paths that anchor the domain (not symbols). Normalized to [] when omitted.
 */

/**
 * DN-2: one ranked domain match produced by the domain resolver
 * (lib/context/domain-resolver.mjs).
 * @typedef {Object} DomainMatch
 * @property {string}   domain           Matched domain id (DomainConfig.domain).
 * @property {number}   score            Additive score in [0, 1] (keyword hits + seed-file glob hit + verbatim id hit).
 * @property {string[]} matchedKeywords  Config keywords that hit the task text (exact or morphological).
 * @property {string[]} matchedGlobs     Domain globs matched by at least one seed file.
 * @property {string|null} contextFile   Repo-relative path to the domain context markdown, or null.
 *                                       Always the path, never the contents — pointers, not payloads (TCM-3).
 * @property {string[]} relatedDomains   Adjacent domain ids copied from config.
 */

/**
 * DN-2: shape of the `.devmate/state/domain-context.json` state file written
 * at the hook boundary on every prompt. Small and pointer-only; downstream
 * consumers (DN-3 dispatch injection, DN-5 skill re-rank) read it by known
 * path. Never written when the config declares no domains.
 * @typedef {Object} DomainContextState
 * @property {number} schemaVersion  Must equal 1 for this version.
 * @property {string} resolvedAt     ISO 8601 timestamp injected by the hook-boundary caller.
 * @property {DomainMatch[]} matches Ranked matches, filtered and capped by the resolver's operating point.
 */

/**
 * DN-3: one budgeted per-domain context entry loaded for a worker dispatch
 * (lib/context/domain-context-load.mjs). Exactly one of content/digest is
 * non-null when the context file exists; both are null when it is missing.
 * @typedef {Object} DomainDispatchContext
 * @property {string}      domain          Domain id (DomainMatch.domain).
 * @property {string[]}    globs           Globs the task's seed files matched for this domain (DomainMatch.matchedGlobs).
 * @property {string[]}    relatedDomains  Adjacent domain ids copied from the match.
 * @property {string|null} contextFile     Repo-relative context-file path from the match, or null when none declared.
 * @property {string|null} content         Full context-file content when it fit the dispatch budget, else null.
 * @property {string|null} digest          Loud truncation fallback (first lines + heading list) when over budget, else null.
 * @property {boolean}     truncated       True when the file existed but was over budget — the dispatch renders a digest + pointer instead, and says so.
 * @property {boolean}     missing         True when contextFile is null or unreadable on disk.
 */

/**
 * Parsed devmate.config.json structure.
 * @typedef {Object} DevmateConfig
 * @property {number}         schemaVersion
 * @property {PersonaEntry[]} personas
 * @property {string[]}       [testGlobs]  E12-2: globs matching test files (defaults applied when absent).
 * @property {number}         [maxConcurrentAgents] E13-4: maximum number of sub-agents the orchestrator may run in parallel. Default 3 applied when absent.
 * @property {string[]}       [sessionArtifactPaths] Issue 93 — globs of session artifacts no agent may hand-edit. Defaults to DEFAULT_SESSION_ARTIFACT_PATHS when absent.
 * @property {SessionArtifactWriter[]} [sessionArtifactWriters] Issue 93 — per-artifact exceptions (glob to agent names). Defaults to DEFAULT_SESSION_ARTIFACT_WRITERS when absent.
 * @property {VerificationConfig} [verification] E14: consumer-declared verification commands.
 * @property {DomainConfig[]} [domains]  DN-1: optional business-domain ownership map. Absent = no domains declared.
 * @property {'multi-root'}   [mode]     B2: when 'multi-root', each persona targets its own repo subdirectory and the loader resolves an absolute repoPath per persona. Absent = single-root (default).
 * @property {string}         [primary]  B2: multi-root only — name of the primary repo (must appear in repos).
 * @property {string[]}       [repos]    B2: multi-root only — repo subdirectory names that make up the workspace.
 */

/**
 * Result of loading devmate.config.json.
 * @typedef {{ ok: true, config: DevmateConfig, warnings?: string[] } | { ok: false, error: string }} ConfigResult
 */

/**
 * E13-3: Dispatch mode chosen by the workstream partitioner after spec-approved.
 * @typedef {'parallel'|'sequential-backend-first'|'sequential-frontend-first'|'sequential-shared-first'} DispatchMode
 */

/**
 * E13-3: Partition of spec files into backend, frontend, and shared buckets.
 * @typedef {Object} WorkstreamPartition
 * @property {string[]}     backendFiles    Files matching only the backend persona globs.
 * @property {string[]}     frontendFiles   Files matching only the frontend persona globs.
 * @property {string[]}     sharedFiles     Files matching both personas or neither.
 * @property {DispatchMode} mode            Dispatch mode derived from the buckets.
 */

/**
 * E13-3: Join condition that must be satisfied before E2E dispatch.
 * @typedef {Object} JoinCondition
 * @property {boolean} backendUnitPass    True when the `backend-unit-pass` dependency gate is `pass`.
 * @property {boolean} frontendUnitPass   True when the `frontend-unit-pass` dependency gate is `pass`.
 * @property {boolean} met                True when both unit-pass gates are `pass`.
 */

/**
 * INTERNAL event for the SubagentStart handler, derived by the hook's main()
 * from the wire payload — NOT the wire shape. The official VS Code payload
 * identifies the agent as `agent_type` (name) + `agent_id` (instance) and
 * carries NO taskId, persona, or repoRoot. This typedef used to document those
 * three as wire fields; that fiction is what made the parser read keys no host
 * sends, so every dispatch degraded to repoRoot = raw cwd and
 * taskId = "unknown" (#76). taskId and persona now come from task.json inside
 * the handler; the root comes from resolveHookRoot.
 * @typedef {Object} SubagentStartEvent
 * @property {string} agentName   Agent name from `agent_type` (fallback `agent_id`); '' when the payload had neither.
 * @property {string} repoRoot    Absolute workspace root from resolveHookRoot.
 * @property {string} [agentId]   Host instance id from `agent_id` — distinguishes two concurrent
 *                                dispatches of the SAME agent, which is what makes the
 *                                `activeAgents` roster removable one instance at a time (#93).
 * @property {string} [persona]   Test-only override. Production leaves it unset: no host event carries
 *                                a persona (SubagentStart has `agent_type` only), and task state no
 *                                longer pretends to hold one — the persona reaches devmate solely on
 *                                the worker's returned contract, at completion (#99).
 */

/**
 * INTERNAL event for the SubagentStop handler — same derivation rules as
 * {@link SubagentStartEvent}. VS Code's SubagentStop payload carries no
 * duration field; `durationMs` exists only as a test override, and the trace
 * records 0 ("not provided by the host") in production.
 * @typedef {Object} SubagentStopEvent
 * @property {string} agentName
 * @property {string} repoRoot
 * @property {string} [agentId]
 * @property {string} [persona]
 * @property {number} [durationMs]
 */

/**
 * One sub-agent the host has told devmate is in flight, recorded at
 * SubagentStart and removed at SubagentStop. The ONLY agent identity devmate
 * holds that the host actually supplied (`agent_type` / `agent_id` on a captured
 * payload) rather than one the model claimed (#93).
 * @typedef {Object} ActiveAgentEntry
 * @property {string} agentName  Host `agent_type` (e.g. 'fullstack', 'spec-writer').
 * @property {string} agentId    Host `agent_id` instance id; '' when the payload omitted it.
 */

/**
 * A session artifact and the agents permitted to write it. The default roster is
 * one entry — `spec.md` → `spec-writer` — because every other artifact is written
 * by a hook, not by an agent.
 * @typedef {Object} SessionArtifactWriter
 * @property {string}            glob    Glob over the workspace-relative artifact path.
 * @property {readonly string[]} agents  Agent names permitted to write paths matching `glob`.
 */

/**
 * E13-4: Typed result returned by the SubagentStart hook.
 * @typedef {Object} SubagentBudgetResult
 * @property {'allowed'|'denied'} decision  Whether the new sub-agent start is allowed.
 * @property {number}             activeCount  Count of active sub-agents after this event is processed.
 * @property {string}             [reason]     Denial reason when decision is 'denied'.
 */

/**
 * HITL-1: verdict from the pure lane-gated implementation-dispatch evaluator
 * (lib/workflow/dispatch-gate.mjs). Shared by the PreToolUse gate-guard and the
 * SubagentStart budget guard so the two hook layers cannot drift.
 * @typedef {Object} DispatchGateResult
 * @property {'allowed'|'denied'} decision  Whether the implementation dispatch may proceed.
 * @property {string}             reason    Actionable message naming the missing step when denied; '' when allowed.
 */

/**
 * Scope entry for a lane. NOTE: per E10 re-spec, prefer PersonaEntry + DevmateConfig.
 * Kept for backwards compatibility with pre-E10 code.
 * @typedef {Object} ScopeEntry
 * @property {Lane}     lane
 * @property {string[]} ownedPaths     Glob patterns this lane owns.
 * @property {string[]} [allowedAgents] Agent IDs allowed to write session artifacts.
 */

// ---- E2-1: loop trace schema types ----

/**
 * Discriminated union of all loop event type strings.
 * @typedef {'loop_attempt'|'loop_halt'|'step_complete'} LoopEventType
 */

/**
 * Base fields shared by all loop trace events.
 * @typedef {Object} LoopTraceEventBase
 * @property {number}        schemaVersion  Must equal SCHEMA_VERSION (1).
 * @property {LoopEventType} type
 * @property {string}        attemptId      Stable UUID for this attempt.
 * @property {string}        taskId
 * @property {string}        ts             ISO-8601 timestamp.
 */

/**
 * A loop attempt event — recorded each time the loop engine runs a command.
 * `tokenEstimate` is optional estimated token cost (outputBytes / 4 heuristic).
 * It is an estimate only — not a billing number.
 * `rerunOf` is set on the second attempt of a flaky-rerun pair — its value is
 * the firstAttemptId of the original failing run.
 * @typedef {LoopTraceEventBase & {
 *   type: 'loop_attempt',
 *   tier: number,
 *   command: string[],
 *   exitCode: number,
 *   outputDigest: string,
 *   fullOutputPath: string,
 *   tokenEstimate?: number,
 *   rerunOf?: string,
 * }} LoopAttemptEvent
 */

/**
 * A loop halt event — recorded when the loop stops due to an unrecoverable error or limit.
 * Valid reasons include: 'MAX_FILES_CHANGED_WITHOUT_VERIFY', 'NO_PROGRESS', 'COST_CAP_EXCEEDED'.
 * @typedef {LoopTraceEventBase & {
 *   type: 'loop_halt',
 *   reason: string,
 *   lastError: string,
 *   priorAttemptId: string | null,
 * }} LoopHaltEvent
 */

/**
 * A step-complete event — recorded when a named step finishes successfully.
 * @typedef {LoopTraceEventBase & {
 *   type: 'step_complete',
 *   stepLabel: string,
 *   artifactPaths: string[],
 * }} LoopStepCompleteEvent
 */

/**
 * Discriminated union of all loop trace event types.
 * @typedef {LoopAttemptEvent | LoopHaltEvent | LoopStepCompleteEvent} AnyLoopEvent
 */

/**
 * A single corrupted JSONL line report from readTraceFile.
 * @typedef {Object} CorruptedLine
 * @property {number} lineNum  1-based line number.
 * @property {string} raw      The raw text of the line.
 * @property {string} error    Description of why parsing/validation failed.
 */

/**
 * Result of reading a JSONL trace file.
 * @typedef {Object} TraceFileResult
 * @property {AnyLoopEvent[]} events         Successfully parsed and validated events.
 * @property {CorruptedLine[]} corruptedLines Lines that failed to parse or validate.
 */

// ---- E2-2: file-change-counter and loop-guard types ----

/**
 * Options for countChangedFiles.
 * @typedef {Object} FileChangeOpts
 * @property {string}   repoRoot          Absolute path to the git repo root.
 * @property {string}   [sinceRef]        Git ref or commitish of the last successful verify.
 *                                        Defaults to HEAD~1 when omitted (safe fallback).
 * @property {string[]} [excludePatterns] Glob patterns to exclude (e.g. 'test/**').
 */

/**
 * Result of running loop guard checks.
 * @typedef {Object} LoopGuardResult
 * @property {boolean} allowed
 * @property {string}  [haltReason]  Present when allowed === false.
 * @property {number}  [fileCount]   Changed file count when haltReason is MAX_FILES_CHANGED_WITHOUT_VERIFY.
 */

// ---- E2-3: no-progress detection types ----

/**
 * Result of running no-progress detection.
 * @typedef {Object} NoProgressResult
 * @property {boolean}      noProgress        True when the current digest matches a prior failure.
 * @property {string|null}  matchedAttemptId  The prior attemptId that matched, or null.
 * @property {string}       currentDigest
 */

// ---- E2-4: cost cap types ----

/**
 * Summary of cumulative token cost across all loop_attempt entries.
 * @typedef {Object} CostSummary
 * @property {number}  totalEstimatedTokens  Sum of tokenEstimate across all loop_attempt entries.
 * @property {number}  attemptCount          Number of loop_attempt entries seen.
 * @property {number}  [capLimit]            max_loop_tokens from config, if set.
 * @property {boolean} capExceeded           True when totalEstimatedTokens >= capLimit.
 */

/**
 * Loop engine configuration shape.
 * @typedef {Object} LoopEngineConfig
 * @property {number}  maxFiles              Hard limit on changed files before verify is required.
 * @property {number}  [max_loop_tokens]     Optional token budget cap. When undefined, the cost
 *                                           check is disabled (opt-in). Not a billing number;
 *                                           uses the outputBytes/4 heuristic from cost-tracker.mjs.
 */

// ---- E2-5: run-command and verify-step types ----

/**
 * Raw result from spawning a child process via runCommand.
 * @typedef {Object} RunCommandResult
 * @property {number}  exitCode     Process exit code (1 when killed by signal).
 * @property {string}  stdout       Full captured stdout.
 * @property {string}  stderr       Full captured stderr.
 * @property {boolean} timedOut     True if the process was killed by the timeout.
 * @property {number}  durationMs   Wall-clock time from spawn to close, in milliseconds.
 */

/**
 * Capped result returned by verifyStep. Never contains raw full output.
 * @typedef {Object} VerifyResult
 * @property {boolean} passed          True when exitCode===0, timedOut===false, and loop-guard allowed.
 * @property {number}  exitCode        Exit code from the command.
 * @property {boolean} timedOut        True if the command was killed by timeout.
 * @property {string}  outputDigest    SHA-256 hex of combined stdout+stderr (first 64 chars).
 * @property {string}  outputCapped    First 4 KB of combined stdout+stderr.
 * @property {string}  fullOutputPath  Absolute path to the full-output artifact file.
 * @property {number}  durationMs      Wall-clock duration of the command.
 */

/**
 * Options accepted by verifyStep.
 * @typedef {Object} VerifyStepOpts
 * @property {string[]} argv         Command as argv array. argv[0] is the binary; no shell string.
 * @property {string}   traceFile    Path to the loop trace JSONL file.
 * @property {string}   taskId
 * @property {string}   attemptId    Stable UUID; caller generates before invoking.
 * @property {number}   [timeoutMs]  Defaults to 120_000 (2 min).
 * @property {string}   [outputDir]  Directory for full-output artifacts. Defaults to '.devmate/output'.
 * @property {number}   [tier]       Verification tier (1-5). Stored in trace.
 * @property {string}   [repoRoot]   Repo root for loop-guard file-change check. Defaults to process.cwd().
 */

// ---- E2-6: flake-rerun types ----

/**
 * Compact result returned by runWithFlakeDetection.
 * Never contains raw full stdout/stderr.
 *
 * Verdicts:
 *   'passed'      — first run passed; no rerun needed.
 *   'flaky'       — first run failed, rerun passed (flaky confirmed).
 *   'stable_fail' — both runs failed with matching digests (stable failure).
 *   'failed'      — both runs failed but digests differ (unstable failure).
 *
 * Callers MUST NOT call step_complete writer when verdict is 'flaky' or 'failed'
 * without human acknowledgement.
 *
 * @typedef {Object} FlakeResult
 * @property {'passed'|'failed'|'flaky'|'stable_fail'} verdict
 * @property {string}      firstAttemptId
 * @property {string|null} rerunAttemptId        Null when first run passed.
 * @property {string}      outputDigest          Digest of the first run's output.
 * @property {string}      outputCapped          Capped output (<=4 KB) of the first run.
 * @property {string}      fullOutputPath        Artifact path for the first run.
 * @property {string|null} rerunFullOutputPath   Artifact path for the rerun, or null.
 * @property {string}      [rerunOutputCapped]   Capped output of the rerun when it also failed.
 * @property {boolean}     timedOut              True if the first run timed out.
 * @property {number}      durationMs            Total wall time for both runs.
 */

/**
 * Options accepted by runWithFlakeDetection.
 * @typedef {Object} FlakeRunOpts
 * @property {string[]} argv
 * @property {string}   traceFile
 * @property {string}   taskId
 * @property {string}   firstAttemptId
 * @property {number}   [timeoutMs]
 * @property {string}   [outputDir]
 * @property {number}   [tier]
 */

// ---- E2-7: output-cap boundary types ----

/**
 * The default return shape from the verify-step boundary.
 * This is what agents receive — NEVER includes raw full output.
 * Canonical implementation: lib/loop/output-cap.mjs (TCM-9).
 *
 * @typedef {Object} LoopOutput
 * @property {boolean} passed             True when exitCode===0, timedOut===false, and loop-guard allowed.
 * @property {number}  exitCode           Process exit code.
 * @property {boolean} timedOut           True if the command was killed by timeout.
 * @property {string}  output_capped      First 4 KB of combined stdout+stderr, secrets redacted.
 * @property {string}  output_digest      SHA-256 hex (64 chars) of the full combined output.
 * @property {string}  full_output_path   Absolute path to the full-output artifact file.
 * @property {number}  durationMs         Wall-clock duration in milliseconds.
 * @property {string}  attemptId          The attempt UUID for this run.
 */

/**
 * Extended shape returned ONLY when --include-full-output is explicitly set.
 * Extends LoopOutput — does NOT replace it.
 * output_full is secrets-redacted but otherwise complete.
 *
 * @typedef {LoopOutput & { output_full: string }} LoopOutputFull
 */

// ---- E3-2: PostToolUse fact-writer types ----

/**
 * A single fact entry written to the task fact ledger.
 * @typedef {Object} FactEntry
 * @property {'fact'}   event
 * @property {string}   key          Stable identity: `${source}:${digestPrefix|ts}`.
 * @property {string}   source       Canonical workspace-relative file path.
 * @property {string}   tool         Tool that triggered the fact.
 * @property {string}   lane         Workflow lane from TaskState, or 'unknown'.
 * @property {string[]} tags         Derived tags (e.g. extension, top-level dir).
 * @property {string}   summary      One-line human-readable summary (<=120 chars).
 * @property {number}   confidence   0-1 float.
 * @property {number}   ts           Unix timestamp ms.
 * @property {string}   stepId       Current stepId from TaskState, or 'none'.
 * @property {boolean}  firstEdit    Source-scoped, not key-scoped; true for the first known fact about the file.
 * @property {string}   [contentDigest] At most 256 hex chars of a content digest (no raw output).
 */

/**
 * Result of a single `writeFact` call.
 * @typedef {Object} FactWriteResult
 * @property {boolean}          ok
 * @property {FactEntry|null}   fact         The entry written, or null if skipped.
 * @property {string|null}      skipReason   Reason fact was not written.
 * @property {string}           ledgerPath
 */

// ---- E3-3: stale-marker types ----

/**
 * The canonical identity of a fact source. Two facts with the same
 * SourceIdentity refer to the same artifact.
 * @typedef {Object} SourceIdentity
 * @property {string} path     Workspace-relative normalised path.
 * @property {string} [digest] Optional content digest at write time (SHA-256 hex, first 16 chars).
 */

/**
 * Reason a prior fact entry was marked stale.
 * @typedef {'changed' | 'renamed' | 'deleted' | 'duplicate'} StaleReason
 */

/**
 * A stale marker entry appended to the ledger.
 * @typedef {Object} StaleEntry
 * @property {'stale'}        event
 * @property {SourceIdentity} source
 * @property {StaleReason}    reason
 * @property {number}         stalledFactTs  Unix timestamp ms of the fact being staled.
 * @property {number}         ts             Unix timestamp ms of this stale event.
 */

/**
 * Result of a `markStale` call.
 * @typedef {Object} MarkStaleResult
 * @property {number}       markedCount  How many prior entries were staled (0 on first edit).
 * @property {boolean}      firstEdit    True when no prior active fact existed for this source.
 * @property {StaleEntry[]} entries      The stale entries appended.
 */

// ---- E3-4: transactional task->repo promotion types ----

/**
 * Policy for resolving a conflict between an existing repo fact and an
 * incoming task fact for the same source.
 * @typedef {'keep-existing' | 'keep-incoming' | 'keep-both'} ConflictPolicy
 */

/**
 * A record of what happened to one task fact during promotion.
 * @typedef {Object} PromotionRecord
 * @property {string}  source         Canonical source path.
 * @property {string}  originalWriter Writer from the task fact (preserved verbatim).
 * @property {number}  originalTs     Timestamp from the task fact (preserved verbatim).
 * @property {number}  promotedTs     Unix ms timestamp of this promotion event.
 * @property {string}  taskId         ID of the task being completed.
 * @property {'promoted'|'skipped'|'conflict_resolved'} status
 */

/**
 * Result of a `promoteLedger` call.
 * @typedef {Object} PromoteResult
 * @property {boolean}           ok
 * @property {number}            promoted    Count of facts written to repo ledger.
 * @property {number}            skipped     Count of stale/duplicate facts skipped.
 * @property {number}            conflicts   Count of conflict resolutions applied.
 * @property {PromotionRecord[]} records
 * @property {string|null}       error       Non-null on failure; task ledger NOT deleted.
 */

/**
 * Options controlling ledger compaction (E3-5).
 * @typedef {Object} CompactOpts
 * @property {number} [maxEntries=200]    Hard cap: entries above this trigger compaction.
 * @property {number} [maxBytes=102400]   Hard cap: bytes above this trigger compaction (100 KB).
 * @property {number} [targetEntries=80]  Target active facts after compaction (mirrors hydrate cap).
 * @property {number} [minConfidence=0.3] Expire active facts below this confidence.
 * @property {number} [expiryAgeDays=90]  Expire active facts older than this many days.
 * @property {string} [archiveDir]        Directory for archived entries. Default: ledgerPath + '.archive'.
 * @property {LockOpts} [lockOpts]        Lock acquisition options.
 * @property {(from: string, to: string) => Promise<void>} [rename] Injectable rename for failure tests.
 */

/**
 * A pointer-rich summary replacing one or more compacted fact entries.
 * @typedef {Object} PointerSummary
 * @property {'pointer_summary'} event
 * @property {string[]} sources         Canonical source paths summarised.
 * @property {string}   summary         <=256 char human-readable digest.
 * @property {string[]} tags            Union of tags from compacted facts.
 * @property {number}   compactedCount  Number of fact entries this replaces.
 * @property {number}   ts              Unix timestamp ms.
 * @property {string}   archivePath     Path to the archive file holding originals.
 */

/**
 * Result of a `compactLedger` call.
 * @typedef {Object} CompactResult
 * @property {boolean} ok
 * @property {number}  entriesBefore
 * @property {number}  entriesAfter
 * @property {number}  bytesBefore
 * @property {number}  bytesAfter
 * @property {number}  expired       Count of facts expired (stale/low-confidence/old).
 * @property {number}  summarised    Count of facts replaced by pointer summaries.
 * @property {string}  archivePath   Where archived entries were written.
 */

/**
 * Lightweight ledger statistics (no full parse).
 * @typedef {Object} LedgerStats
 * @property {number} entryCount  Total non-empty lines.
 * @property {number} activeCount Active (non-staled) `fact` entries.
 * @property {number} discoveryActiveCount  Active `fact` entries that are
 *   semantic discovery facts (tool === the discovery marker) — the subset the
 *   committed .devmate/MEMORY.md actually renders (Issue 150). Always ≤ activeCount.
 * @property {number} bytes       File size in bytes.
 */

/**
 * A pointer to an artifact produced by a step (E3-6). Follows TCM-3: path +
 * line range, not pasted content.
 * @typedef {Object} ArtifactPointer
 * @property {string} path        Workspace-relative file path.
 * @property {string} [lineRange] e.g. "12-45".
 * @property {string} kind        e.g. 'test-output', 'source-file', 'trace-entry'.
 * @property {string} [digest]    SHA-256 hex of artifact content (first 16 chars).
 */

/**
 * A memory-side step-completion event (E3-6). Distinct from the strict loop
 * `step_complete` event in `lib/loop/trace-schema.mjs`.
 * @typedef {Object} StepCompleteEntry
 * @property {'step_complete'}   event
 * @property {string}            stepId        Stable unique identifier (not label-only).
 * @property {string}            label         Human-readable step label (<=80 chars).
 * @property {string}            taskId        Parent task identifier.
 * @property {string}            lane          Workflow lane.
 * @property {ArtifactPointer[]} artifacts     Pointers to outputs produced by this step.
 * @property {string}            [verifyOutput] Capped verification summary (<=512 chars).
 * @property {number}            ts            Unix ms timestamp.
 */

/**
 * Result of a `writeStepComplete` call.
 * @typedef {Object} WriteStepCompleteResult
 * @property {boolean}           ok
 * @property {StepCompleteEntry} entry
 * @property {string}            tracePath
 * @property {string|null}       error
 */

/**
 * Token/context budget tier (E4-1).
 * - `tiny`     quick task, no subagents, max 3 evidence pointers.
 * - `standard` normal feature/bug/chore, max 10 evidence pointers per stage.
 * - `large`    only after explicit router decision; requires ContextReducer.
 * @typedef {'tiny'|'standard'|'large'} BudgetClass
 */

/**
 * A typed, persisted budget contract every workflow starts with (E4-1).
 * @typedef {Object} OutputContract
 * @property {string}      lane              'feature'|'bug'|'chore'|'help'|'learn'|'rollback'|'pr-ready'.
 * @property {string}      format            'pr'|'patch'|'report'|'answer'.
 * @property {string}      audience          'user'|'orchestrator'|'reviewer'.
 * @property {string}      done_when         Completion predicate (one sentence).
 * @property {string[]}    evidence_required Required evidence kinds, e.g. ['stack-trace','failing-test'].
 * @property {'inline'|'pointer'} citation_mode How to cite evidence in outputs.
 * @property {BudgetClass} token_budget_class
 * @property {number}      max_context_sources Max evidence pointers allowed per stage.
 * @property {string}      created_at        ISO-8601 timestamp.
 */

/**
 * A pointer to a piece of evidence, loaded just-in-time (E4-2, TCM-3).
 * @typedef {Object} EvidencePointer
 * @property {string} path        Repo-relative or absolute file path.
 * @property {[number,number]|null} lineRange [startLine, endLine] (1-based, inclusive); null = whole file.
 * @property {string} reason      Why this evidence is relevant (one sentence).
 * @property {number} confidence  0.0-1.0 relevance confidence.
 * @property {string} freshness   ISO-8601 timestamp of last file modification or retrieval.
 * @property {'file'|'url'|'trace'|'tool-output'} kind Evidence kind.
 */

/**
 * A typed, budget-capped list of evidence pointers serving one workflow stage (E4-2).
 * @typedef {Object} EvidencePack
 * @property {string}            taskId     Owning task ID.
 * @property {string}            stage      Workflow stage this pack serves, e.g. 'discovery'.
 * @property {EvidencePointer[]} pointers   Ordered list of pointers; length <= maxSources.
 * @property {number}            maxSources From OutputContract.max_context_sources.
 * @property {string}            created_at ISO-8601 timestamp.
 */

/* ------------------------------------------------------------------ *
 * E4-3: ContextReducer MapReduce types for oversized evidence packs.  *
 * ------------------------------------------------------------------ */

/**
 * Summary of one chunk produced by the Reduce phase. Always carries the
 * originating pointers back so downstream stages can reload exact slices (TCM-6).
 * @typedef {Object} ChunkSummary
 * @property {number}            chunkIndex     0-based chunk position.
 * @property {string}            summary        Compact summary text (max 300 chars).
 * @property {EvidencePointer[]} sourcePointers Pointers that contributed to this chunk.
 * @property {string[]}          preservedFacts Key facts extracted verbatim (max 5 per chunk).
 */

/**
 * Result of reducing an oversized EvidencePack via MapReduce.
 * @typedef {Object} ReducedPack
 * @property {string}            taskId
 * @property {string}            stage
 * @property {string}            mergeSummary  Combined narrative across all chunks (max 800 chars).
 * @property {ChunkSummary[]}    chunks        All chunk summaries with back-pointers.
 * @property {EvidencePointer[]} allPointers   Deduplicated union of all source pointers.
 * @property {number}            originalCount How many pointers were in the input pack.
 * @property {string}            reducedAt     ISO-8601 timestamp.
 */

/* ------------------------------------------------------------------ *
 * E4-6: session-budget snapshot + warning types (TCM-11).            *
 * ------------------------------------------------------------------ */

/**
 * A measurement of the current session's context component sizes (E4-6).
 *
 * #87: `traceSummaryBytes` is measured but is NOT part of `totalEstimatedTokens`.
 * The trace is an on-disk event log that never enters the model's prompt; summing
 * it into a context budget is a category error, and it is the reason the budget
 * warned on every tool call and blocked edits it could not unblock. It is
 * reported through its own non-blocking diagnostic instead — see
 * TraceSizeDiagnostic.
 * @typedef {Object} BudgetSnapshot
 * @property {number} sessionMarkdownBytes  Bytes of loaded session markdown (in context).
 * @property {number} traceSummaryBytes     Bytes of the on-disk trace file. Measured, NOT counted.
 * @property {number} loadedSkillCount      Number of skill stubs currently loaded.
 * @property {number} recentToolOutputBytes Bytes of the most recent recorded tool output (in context).
 * @property {number} contextTokens         Running total of tokens the host has fed back to the model
 *                                          as tool results this task (the context meter). The one
 *                                          counted component with a producer in production.
 * @property {number} totalEstimatedTokens  The in-context total: estimateTokens(session + tool output)
 *                                          + contextTokens. Excludes the trace.
 * @property {string} measuredAt            ISO-8601 timestamp.
 */

/**
 * A budget warning produced by comparing a BudgetSnapshot to BudgetClass caps.
 * @typedef {Object} BudgetWarning
 * @property {'ok'|'warn'|'critical'} level
 * @property {string}         message         One-line human-readable warning.
 * @property {string[]}       cleanupActions  Exact steps the agent should take now. Every entry names
 *                                            a mechanism that exists — advice with no implementation
 *                                            behind it is not an action.
 * @property {BudgetSnapshot} snapshot        The measurements that triggered this warning.
 * @property {number}         thresholdTokens The limit that was approached or exceeded.
 */

/**
 * #87: the trace-size diagnostic. Reported on its own tag (`[TRACE:size]`), with
 * its own threshold. It never contributes to a BudgetWarning level, never writes
 * the budget-critical marker, and never blocks a tool call — the trace is not in
 * context, so its size costs the model nothing. It is surfaced because a trace
 * growing without bound is evidence of a loop.
 * @typedef {Object} TraceSizeDiagnostic
 * @property {'ok'|'warn'} level
 * @property {number} tokens       Estimated tokens the trace file would be, if it were in context.
 * @property {number} limitTokens  The diagnostic threshold crossed.
 * @property {string} message      Empty when level is ok.
 */

/**
 * #87: the running count of what devmate has actually put into the model's
 * context. Persisted as a sidecar (`.devmate/state/context-meter.json`) next to
 * task.json, incremented once per PostToolUse from the payload's `tool_response`,
 * and zeroed by compaction.
 * @typedef {Object} ContextMeter
 * @property {number} schemaVersion
 * @property {number} contextTokens   Estimated tokens of tool results fed to the model this task.
 * @property {number} toolResults     How many tool results contributed.
 * @property {string|null} lastReportId  Identity of the last budget line reported, so an unchanged
 *                                        breach is not re-reported on every tool call.
 */

/**
 * #87: what a `resetContextBudget` run actually reduced. Every field is
 * best-effort — a failure to tidy one component must never abort the compaction
 * that is the caller's real job — so the failures ride along in `errors` rather
 * than throwing.
 * @typedef {Object} ContextBudgetReset
 * @property {string|null} sessionArchivedTo      Where the session markdown was moved, or null.
 * @property {boolean} toolOutputPointerCleared
 * @property {boolean} contextMeterReset
 * @property {boolean} markerCleared
 * @property {string[]} errors
 */

/* ------------------------------------------------------------------ *
 * E4-7: session compaction artifact (TCM-7).                         *
 * ------------------------------------------------------------------ */

/**
 * A typed, high-recall session compaction artifact. A fresh session can load
 * this as its only source of truth, with no conversation history or trace replay.
 * @typedef {Object} CompactionArtifact
 * @property {string}   schemaVersion          e.g. '1.0'.
 * @property {string}   taskId
 * @property {string}   compactedAt            ISO-8601 timestamp.
 * @property {string}   goal                   Original task goal (verbatim from TaskState/OutputContract).
 * @property {string[]} acceptedDecisions      Finalized decisions; each is one sentence.
 * @property {string[]} constraints            Non-negotiable constraints carried forward.
 * @property {string[]} unresolvedBugs         Open bugs noted during the session; each with a pointer if known.
 * @property {string[]} implementationDetails  Key implementation details; reference file+line where possible.
 * @property {EvidencePointer[]} evidencePointers  Preserved pointers; no pasted content.
 * @property {string[]} risks                  Identified risks or open questions.
 * @property {string}   nextAction             Concrete next step for the resuming agent (one sentence).
 * @property {string}   compactedBy            Script version or source, e.g. 'compact-session.mjs@1.0'.
 * @property {string[]} droppedCategories      What was deliberately dropped (e.g. 'duplicate-tool-output').
 */

/* ------------------------------------------------------------------ *
 * E4-8: worker return contract (TCM-10).                             *
 * ------------------------------------------------------------------ */

/**
 * The canonical contract a worker (sub-agent) returns to the orchestrator. A
 * compact, typed summary — never a raw transcript (except in narrow debug mode).
 * @typedef {Object} WorkerReturn
 * @property {string}   workerId              Unique identifier for the worker script/agent.
 * @property {string}   finding               Concise summary of what was found or done (max 500 chars).
 * @property {EvidencePointer} sourcePointer  Primary evidence pointer.
 * @property {number}   confidence            0.0-1.0 confidence in the finding.
 * @property {string|null} artifactWritten    Path to any artifact the worker wrote; null if none.
 * @property {string}   nextRecommendedStep   What the orchestrator should do next (one sentence, max 200 chars).
 * @property {string}   tokenNotes            Summary of context cost, e.g. 'Loaded 2 slices, ~800 tokens'.
 * @property {boolean}  debugMode             If true, rawTranscriptPath may be set; forbidden in production.
 * @property {string|null} rawTranscriptPath  Set only when debugMode=true; null otherwise.
 * @property {string}   returnedAt            ISO-8601 timestamp.
 */

/* ------------------------------------------------------------------ *
 * E8-1: orchestrator-workers fanout types.                          *
 * ------------------------------------------------------------------ */

/**
 * Fanout worker thunk invoked by lib/orchestrator/fanout.mjs.
 * Receives an optional AbortSignal for best-effort cancellation on timeout.
 * @typedef {(signal?: AbortSignal) => Promise<WorkerReturn>} FanoutWorker
 */

/**
 * Options controlling a multi-worker fanout.
 * When `strict` is true, only 'large' budget class is permitted (legacy E8-1 behaviour).
 * When `strict` is false (default), all budget classes are permitted.
 * @typedef {Object} FanoutOpts
 * @property {BudgetClass} budgetClass       Budget class for this fanout run.
 * @property {number}  [timeoutMs=30000]     Per-worker deadline in milliseconds.
 * @property {boolean} [dryRun=false]        Plan would-run workers; do not execute.
 * @property {number}  [minSuccessRate]      Optional success-rate floor in [0,1].
 * @property {string}  [telemetryPath]       Override the telemetry ledger path (tests).
 * @property {boolean} [strict=false]        When true, enforces budgetClass === 'large' (E8-1 legacy behaviour).
 */

/**
 * Per-worker token + latency telemetry, appended to evals/telemetry/workers.jsonl.
 * @typedef {Object} WorkerTelemetry
 * @property {string}  workerId
 * @property {number}  promptTokens      Estimated tokens sent to the worker.
 * @property {number}  completionTokens  Estimated tokens in the worker return.
 * @property {number}  latencyMs         Wall-clock time the worker took.
 * @property {boolean} contractValid     True if validateWorkerReturn passed.
 */

/**
 * Aggregated result of a fanout run. `results` holds only validated, typed
 * WorkerReturn objects — never raw transcripts (TCM-10).
 * @typedef {Object} FanoutResult
 * @property {WorkerReturn[]}    results     Validated worker returns.
 * @property {WorkerTelemetry[]} telemetry   One entry per attempted worker.
 * @property {string[]}         violations  Worker IDs that failed contract/timeout.
 * @property {boolean}          dryRun      True when this was a plan-only run.
 * @property {number}           planned     Count of workers that would run (dryRun).
 * @property {number}           succeeded   Number of successful workers (equals results.length).
 * @property {boolean}          insufficient True when a configured minSuccessRate floor is not met.
 */

/* ------------------------------------------------------------------ *
 * E8-2: advanced memory retrieval + glossary validation types.       *
 * ------------------------------------------------------------------ */

/**
 * A single glossary entry: a pointer from a domain term to where the concept
 * lives in the repo (TCM-3 — pointer, not pasted definition). `staleReason` is
 * present only when the entry failed live-file validation.
 * @typedef {Object} GlossaryEntry
 * @property {string}   term         Canonical concept name.
 * @property {string}   definition   One-sentence definition.
 * @property {string[]} sourceFiles  Relative paths to files where this concept lives.
 * @property {string}   [staleReason] Set if the term is stale; absent if fresh.
 * @property {string}   updatedAt    ISO date of last validation.
 */

/**
 * A selective glossary query. Returns only relevant entries — never the whole
 * ledger — so an obsolete glossary cannot be injected wholesale.
 * @typedef {Object} GlossaryQuery
 * @property {string}  text            Free-text query.
 * @property {number}  [maxResults=5]  Cap on returned entries.
 * @property {boolean} [excludeStale=true] Suppress stale entries (default true).
 */

/**
 * Result of a glossary query.
 * @typedef {Object} GlossaryResult
 * @property {GlossaryEntry[]} entries          Matched, capped entries.
 * @property {number}          staleSuppressed  Count of stale entries excluded.
 */

// ---- E5-1 (with E10 re-spec): bug-lane diagnosis handoff types ----

/**
 * Bug scope = the persona (from devmate.config.json) responsible for the fix,
 * or 'unknown' when diagnosis could not pin a layer.
 *
 * E10 re-spec note: this is NO LONGER a fixed enum. The fixed
 * `backend|frontend|editor` split is removed. `bugScope` carries the name of a
 * persona that exists in the consumer's `devmate.config.json` (e.g. 'frontend',
 * 'backend', 'fullstack', ...), plus the literal 'unknown'. The persona list is
 * open and config-sourced; it is not chosen from a built-in list.
 * @typedef {string} BugScope
 */

/**
 * Typed output of the @diagnose agent. Validated on every read.
 * @typedef {Object} DiagnosisResult
 * @property {BugScope} bugScope            Persona-from-config that owns the fix, or 'unknown'.
 * @property {string}   suspectedLayer       Human-readable layer description.
 * @property {string}   reproCommand         Exact command (argv joined) to reproduce.
 * @property {string}   fixerRecommendation  Free-text guidance for the fixer agent.
 * @property {string[]} allowedPaths         Exact files the fix may touch — the bug lane's edit boundary (#92).
 * @property {string[]} allowedGlobs         Glob boundary for the same; at least one of the two must be non-empty.
 * @property {string}   taskId
 * @property {number}   schemaVersion        Must equal 1 for this version.
 */

/**
 * Typed output of the @rubber-duck agent in grill mode.
 * @typedef {Object} GrillResult
 * @property {string} taskId
 * @property {'grill'} mode
 * @property {number} schemaVersion Must equal 1 for this version.
 * @property {string} returnedAt
 * @property {string[]} assumptions
 * @property {string[]} missingRequirements
 * @property {string[]} edgeCases
 * @property {string[]} cornerCases
 * @property {string[]} securityRisks
 * @property {string[]} uxRisks
 * @property {string[]} blockingQuestions
 * @property {string[]} recommendedDecisions
 * @property {string[]} unverifiedItems Items from upstream artifacts addressed in this critique. Every entry must start with `[UNVERIFIED]`.
 * @property {string[]} risks Derived aggregate of securityRisks and uxRisks; kept for convenience. See securityRisks and uxRisks for per-category access.
 * @property {number} revisionsRequested Iteration counter passed by the orchestrator (0, 1, or 2).
 */

/**
 * Typed output of the @rubber-duck agent in critique mode.
 * @typedef {Object} CritiqueResult
 * @property {string} taskId
 * @property {'critique'} mode
 * @property {number} schemaVersion Must equal 1 for this version.
 * @property {string} returnedAt
 * @property {string[]} missingAcceptanceCriteria
 * @property {string[]} missingTests
 * @property {string[]} riskySequencing
 * @property {string[]} unlistedFiles
 * @property {string[]} backwardsCompatRisks Prefer GrillResult.risks for new consumers. Retained for backwards compatibility with existing critique consumers.
 * @property {string} rollbackRisk
 * @property {'APPROVE_PLAN'|`REQUEST_REVISION:${string}`} verdict
 * @property {number} revisionsRequested Iteration counter passed by the orchestrator (0, 1, or 2).
 */

/**
 * Fixer dispatch target.
 *
 * E10 re-spec note: there is ONE generic agent, `agents/fullstack.agent.md`.
 * `FixerTarget` is therefore the single literal `'@fullstack'`. The persona is
 * passed as dispatch input, NOT encoded in the agent name. The old
 * `'@backend'|'@frontend'|'@editor'` split is removed.
 * @typedef {'@fullstack'} FixerTarget
 */

/**
 * Result of selecting a fixer from a DiagnosisResult.
 * @typedef {Object} FixerSelection
 * @property {FixerTarget} target   Always '@fullstack' (one generic agent).
 * @property {string}      persona  The persona-from-config to dispatch as (may be 'unknown').
 * @property {string}      reason   Human-readable explanation of the selection.
 */

/* ------------------------------------------------------------------ *
 * E6-1: Unified trace event taxonomy.                                 *
 * Single typedef source for all unified trace event types. Events are   *
 * appended via `lib/trace/append.mjs` to                              *
 * `.devmate/state/trace/<taskId>.jsonl`.                              *
 * ------------------------------------------------------------------ */

/**
 * The unified trace event types.
 * @typedef {'action'|'gate_transition'|'loop_attempt'|'loop_halt'|'step_complete'|'fact_write'|'compaction'|'budget_warning'|'grill_complete'|'critique_complete'|'plan_revised'|'spec_revision_requested'|'no_tdd_override'|'spec_invalidated'|'subagent_start'|'subagent_complete'|'subagent_reconciled'|'contract_violation'|'model_route'|'discovery_merge'} TraceEventType
 */

/**
 * Fields common to every trace event.
 * @typedef {Object} TraceEventBase
 * @property {TraceEventType} type
 * @property {string} stepId         Stable UUID or deterministic hash — never label-only.
 * @property {string} taskId
 * @property {string} ts             ISO-8601 timestamp.
 * @property {number} schemaVersion
 */

/*
 * Reconciliation note: the loop-trace taxonomy from E2/E3 already owns the
 * names `LoopAttemptEvent`, `LoopHaltEvent`, and `LoopStepCompleteEvent` (see
 * above) with different field shapes. To avoid collision, the E6-1 unified
 * per-type typedefs are prefixed `Trace*`. The union/base names the spec calls
 * out verbatim (`TraceEvent`, `TraceEventType`, `TraceEventBase`) are unique
 * and kept as-is.
 */

/**
 * An agent action was performed (file write, command, etc.).
 * @typedef {TraceEventBase & { actionType: string, path: string, digest: string }} TraceActionEvent
 */

/**
 * E6-4: Caller-supplied input for auditAction. The `ts`, `type`, `digest`, and
 * `schemaVersion` fields are filled in by auditAction itself — the caller only
 * provides identity (taskId/stepId) plus the action descriptor. The digest is
 * always derived from (path + actionType), never from file content.
 * @typedef {Object} AuditActionEntry
 * @property {string} taskId
 * @property {string} stepId
 * @property {string} actionType   e.g. 'write', 'command', 'edit'.
 * @property {string} path         File path or command target the action touched.
 */

/**
 * A workflow gate transition occurred.
 * E10-03: human-gate approvals additionally carry the audit pair — `actor`
 * (who issued the transition, e.g. `orchestrator` or `hook-exact-phrase`) and
 * `evidence` (the verbatim human message that justified it). Both are
 * optional so internal/auto gate transitions remain schema-compatible.
 * @typedef {TraceEventBase & { from: string, to: string, gate: string, actor?: string, evidence?: string }} TraceGateTransitionEvent
 */

/**
 * A single attempt within a verification / fix loop.
 * @typedef {TraceEventBase & { attempt: number, command: string[], exitCode: number, digest: string }} TraceLoopAttemptEvent
 */

/**
 * A loop halted (gave up) after exhausting attempts or hitting a fatal error.
 * @typedef {TraceEventBase & { reason: string, attempt: number, last_error: string }} TraceLoopHaltEvent
 */

/**
 * A workflow step completed, with pointers to its artifacts.
 * @typedef {TraceEventBase & { label: string, artifactPaths: string[] }} TraceStepCompleteEvent
 */

/**
 * A fact / memory entry was written.
 * @typedef {TraceEventBase & { factKey: string, scope: string, sourcePointer: string }} TraceFactWriteEvent
 */

/**
 * A ledger / trace compaction event.
 * @typedef {TraceEventBase & { artifactPath: string, entriesBefore: number, entriesAfter: number }} TraceCompactionEvent
 */

/**
 * A budget threshold warning.
 * @typedef {TraceEventBase & { field: string, current: number, limit: number }} TraceBudgetWarningEvent
 */

/**
 * E11-3: Rubber-duck grill stage finished. Emitted by the orchestrator after
 * the rubber-duck grill sub-stage runs, before the planner stage begins.
 * @typedef {TraceEventBase & {
 *   type: 'grill_complete',
 *   assumptions: string[],
 *   edgeCases: string[],
 *   cornerCases: string[],
 *   blockingQuestions: string[]
 * }} GrillCompleteEvent
 */

/**
 * E11-3: Rubber-duck critique stage finished. The verdict is either an
 * approval (`APPROVE_PLAN`) or a revision request encoded as
 * `REQUEST_REVISION:<reason>`. The orchestrator caps critique cycles at 2.
 * @typedef {TraceEventBase & {
 *   type: 'critique_complete',
 *   verdict: 'APPROVE_PLAN'|`REQUEST_REVISION:${string}`,
 *   missingTests: string[],
 *   risks: string[],
 *   iterationNumber: number
 * }} CritiqueCompleteEvent
 */

/**
 * E11-3: A planner revision was produced in response to a critique
 * REQUEST_REVISION verdict. `revision` is the 1-based revision number
 * (1 or 2, since critique is capped at 2 cycles).
 * @typedef {TraceEventBase & {
 *   type: 'plan_revised',
 *   revision: number,
 *   reason: string
 * }} PlanRevisedEvent
 */

/**
 * E10-2: Emitted when the human types `revise spec: <feedback>` so the
 * orchestrator can re-run discovery -> grill -> plan -> critique and
 * rewrite the spec without creating a new gate.
 * @typedef {TraceEventBase & {
 *   type: 'spec_revision_requested',
 *   feedback: string
 * }} SpecRevisionRequestedEvent
 */

/**
 * E10-2: Emitted when the human approves a no-TDD override via
 * `approve no-tdd reason="..."`. The reason is also appended to spec.md's
 * Out of scope section by the approval-listener hook when a spec exists.
 * @typedef {TraceEventBase & {
 *   type: 'no_tdd_override',
 *   reason: string
 * }} NoTddOverrideEvent
 */

/**
 * E10-3: Emitted by the spec-integrity guard when spec.md is modified after
 * the spec-approved gate is reached. The guard rolls the gate back to
 * spec-draft so the human must re-approve the updated spec.
 * @typedef {TraceEventBase & {
 *   type: 'spec_invalidated',
 *   reason: string
 * }} SpecInvalidatedEvent
 */

/**
 * E13-4: Emitted by the subagent-budget-guard SubagentStart hook on every
 * allowed sub-agent start. Lets a reader of the per-task trace see exactly
 * which persona was dispatched and how many sub-agents were active after the
 * start.
 * @typedef {TraceEventBase & {
 *   type: 'subagent_start',
 *   agentName: string,
 *   persona: string,
 *   activeCount: number
 * }} SubagentStartTraceEvent
 */

/**
 * E13-4: Emitted by the subagent-budget-guard SubagentStop hook on every
 * sub-agent stop. Captures the duration the sub-agent ran and the active
 * count after the stop decremented it (floored at 0).
 * @typedef {TraceEventBase & {
 *   type: 'subagent_complete',
 *   agentName: string,
 *   persona: string,
 *   durationMs: number,
 *   activeCount: number
 * }} SubagentCompleteTraceEvent
 */

/**
 * DN-6: Emitted by `scripts/session-start.mjs` when a nonzero
 * `activeSubagents` counter is found at SessionStart and reset to 0. A fresh
 * session implies no prior sub-agent survives, so any nonzero value is
 * stale (e.g. a hard interrupt left `SubagentStop` unfired). `previous`
 * records the value that was reconciled away.
 * @typedef {TraceEventBase & {
 *   type: 'subagent_reconciled',
 *   previous: number
 * }} SubagentReconciledTraceEvent
 */

/**
 * Emitted by contract-validation guards when an artifact contract fails at
 * runtime. This event is appended before the hook returns exit 1.
 * @typedef {TraceEventBase & {
 *   type: 'contract_violation',
 *   contract: string,
 *   path: string,
 *   errors: string[]
 * }} ContractViolationEvent
 */

/**
 * E9-11: a budget-class model recommendation recorded at dispatch.
 * @typedef {TraceEventBase & {
 *   type: 'model_route',
 *   budgetClass: string,
 *   modelId: string,
 *   mode: string
 * }} ModelRouteEvent
 */

/**
 * FO-5: Emitted by `scripts/merge-discovery.mjs` after the discovery fan-in.
 * Counts describe the merge: `inputs` (discovery worker-return artifacts
 * read), `merged` (claims kept post-cap), `dropped` (claims demoted to
 * unverified by the cap), and `conflicts` (per-file needsReview groups).
 * @typedef {TraceEventBase & {
 *   type: 'discovery_merge',
 *   inputs: number,
 *   merged: number,
 *   dropped: number,
 *   conflicts: number
 * }} DiscoveryMergeEvent
 */

/**
 * Union of all unified trace events (E6-1 + E11-3 + E10-2 + E10-3 + E13-4 + E9-11 + DN-6 + FO-5).
 * @typedef {TraceActionEvent|TraceGateTransitionEvent|TraceLoopAttemptEvent|TraceLoopHaltEvent|TraceStepCompleteEvent|TraceFactWriteEvent|TraceCompactionEvent|TraceBudgetWarningEvent|GrillCompleteEvent|CritiqueCompleteEvent|PlanRevisedEvent|SpecRevisionRequestedEvent|NoTddOverrideEvent|SpecInvalidatedEvent|SubagentStartTraceEvent|SubagentCompleteTraceEvent|SubagentReconciledTraceEvent|ContractViolationEvent|ModelRouteEvent|DiscoveryMergeEvent} TraceEvent
 */

/**
 * Result of validating a trace event.
 * @typedef {Object} TraceValidationResult
 * @property {boolean} ok
 * @property {string[]} errors
 */

/* ------------------------------------------------------------------ *
 * E6-2: read-trace resume semantics.                                  *
 * ------------------------------------------------------------------ */

/**
 * One step in a trace, grouped by stable `stepId`.
 * @typedef {Object} TraceStep
 * @property {string} stepId          Stable identity — never label-only.
 * @property {string} label           Human label (may repeat; stepId disambiguates).
 * @property {TraceEventType} lastEventType
 * @property {string} ts              Timestamp of last event for this stepId.
 * @property {boolean} completed      True iff a `step_complete` event exists for stepId.
 * @property {boolean} halted         True iff a `loop_halt` event exists for stepId (with no later step_complete).
 */

/**
 * Structured summary used to decide where to resume a halted task.
 * @typedef {Object} ResumeSummary
 * @property {TraceStep|null} lastCompleted   Most recent step with `completed=true`.
 * @property {TraceStep|null} currentBlocked  Most recent step with `halted=true` and no later `step_complete`.
 * @property {string|null}    nextLegalAction Suggested action string, or null if task is fully complete.
 * @property {number}         malformedCount  Count of unparseable or schema-invalid lines.
 * @property {number[]}       malformedLines  1-based line numbers that failed to parse or validate.
 */

/**
 * Full result of reading a task's trace.
 * @typedef {Object} ReadTraceResult
 * @property {TraceStep[]}   steps
 * @property {ResumeSummary} summary
 * @property {number}        totalLines
 */

/* ------------------------------------------------------------------ *
 * E6-3: Handoff artifact for cold resume.                             *
 * ------------------------------------------------------------------ */

/**
 * A pointer to evidence inside a handoff brief — never raw content, only a
 * path/URL + metadata.
 *
 * Reconciliation note: the E4-2 evidence-pack taxonomy already owns the name
 * `EvidencePointer` (numeric confidence, tuple lineRange). The handoff brief
 * uses a distinct, simpler shape (string confidence, string line_range), so it
 * is named `HandoffEvidencePointer` to avoid a duplicate-identifier collision.
 * @typedef {Object} HandoffEvidencePointer
 * @property {'file'|'trace'|'url'} kind
 * @property {string} path_or_url
 * @property {string} [line_range]    e.g. "12-34"
 * @property {string} why_relevant
 * @property {'high'|'medium'|'low'} confidence
 */

/**
 * Typed handoff brief enabling cold resume without history replay.
 * @typedef {Object} HandoffArtifact
 * @property {string}            taskId
 * @property {string}            purpose        One sentence: what this task is trying to accomplish.
 * @property {string}            currentState   One of: 'in_progress'|'halted'|'compacted'|'completed'.
 * @property {string[]}          decisions      Accepted decisions, immutable for this task.
 * @property {string[]}          openQuestions  Unresolved questions blocking or adjacent to progress.
 * @property {HandoffEvidencePointer[]} evidencePointers
 * @property {string|null}       suggestedNextSkill
 * @property {string[]}          blockers
 * @property {string}            ts             ISO-8601 creation timestamp.
 * @property {number}            schemaVersion
 */

/**
 * Input to writeHandoff — the artifact minus the stamped fields.
 * @typedef {Omit<HandoffArtifact, 'ts'|'schemaVersion'>} HandoffInput
 */

/* ------------------------------------------------------------------ *
 * E6-5: resume UX that never repeats completed work.                  *
 * ------------------------------------------------------------------ */

/**
 * What the resume CLI should do next for a task.
 * @typedef {'proceed'|'confirm_needed'|'blocked_halt'|'already_complete'} ResumeAction
 */

/**
 * Plan describing how to resume a task, built from the trace (and optional
 * handoff artifact). Never carries raw trace content — only decisions.
 * @typedef {Object} ResumePlan
 * @property {string}               taskId
 * @property {ResumeAction}         action            What the CLI should do next.
 * @property {string}               message           Human-readable one-liner.
 * @property {string|null}          nextStepId        stepId to dispatch next, or null.
 * @property {string|null}          nextStepLabel     Human label of that step.
 * @property {boolean}              handoffAvailable  True if a handoff.json was found and loaded.
 * @property {boolean}              compactionAvailable  True if a self-sufficient compaction artifact was found.
 * @property {ResumeSummary}        traceSummary
 * @property {HandoffArtifact|null} handoff
 * @property {CompactionArtifact|null} [compaction]  The loaded compaction artifact, if any.
 * @property {ImplProgress}         [implProgress]   Per-AC implementation progress, present only
 *                                                   when the caller supplied the acceptance-criteria
 *                                                   list (feature lane at/after `impl-started`).
 */

/**
 * Per-acceptance-criterion implementation progress, derived from the canonical
 * trace's `impl-AC{n}` `step_complete` events joined against the persisted
 * `TaskState.acceptanceCriteria` list. Surfaced on resume and in the
 * `<devmate-state>` anchor so a resumed session knows exactly which ACs are done
 * and which to implement next.
 * @typedef {Object} ImplProgress
 * @property {number}      done         Count of completed acceptance criteria.
 * @property {number}      total        Total acceptance criteria (0 when the list is unknown).
 * @property {number[]}    completedIds Sorted 1-based ids of completed acceptance criteria.
 * @property {number|null} nextId       1-based id of the next incomplete AC, or null when none remain.
 * @property {string|null} nextLabel    Text of the next incomplete AC, or null.
 */

/* ------------------------------------------------------------------ *
 * E3-7: bounded repo-memory query for later tasks.                    *
 * ------------------------------------------------------------------ */

/**
 * A request to query the repo memory ledger for relevant facts.
 * @typedef {Object} MemoryQueryRequest
 * @property {string}   [lane]       Filter to facts from this lane (e.g. 'feature', 'bug').
 * @property {string}   [pathPrefix] Only return facts whose source path starts with this prefix.
 * @property {string[]} [tags]       Boost facts matching any of these tags.
 * @property {string}   [text]       Free-text hint; used for lightweight keyword scoring.
 * @property {number}   [topN]       Maximum number of matches to return (default 10).
 * @property {boolean}  [includeExpired] If true, include stale facts (for audit).
 */

/**
 * A single match returned by queryMemory. Pointers and summaries only — no raw
 * fact payload beyond the summary field (TCM-3).
 * @typedef {Object} MemoryMatch
 * @property {string}   source           Canonical workspace-relative path.
 * @property {string}   summary          Fact summary (<=256 chars).
 * @property {string[]} tags
 * @property {string}   lane
 * @property {number}   confidence
 * @property {number}   score            Relevance score computed by queryMemory (0-1 float).
 * @property {number}   ts               Fact timestamp.
 * @property {boolean}  isPointerSummary True if this match is a PointerSummary, not a raw fact.
 * @property {'discovery'} [kind]        Present when the fact came from the discovery-merge write path (FO-6).
 * @property {string}   [contentDigest]  Discovery facts only: 16-hex digest of the referenced file at write time.
 * @property {boolean}  [stale]          Present only under a stale check: true when the referenced file changed or is missing.
 */

/**
 * Result of a queryMemory call.
 * @typedef {Object} MemoryQueryResult
 * @property {boolean}      ok
 * @property {MemoryMatch[]} matches     At most topN matches, sorted descending by score.
 * @property {number}        totalActive Total active (non-staled) entries scanned.
 * @property {number}        scanned     Total lines read.
 * @property {number}        [driftedExcluded] Fact matches dropped because their source no longer resolves (verify-before-use).
 * @property {string|null}   error
 */

/* ------------------------------------------------------------------ *
 * E4-4: split skills into tiny triggers plus lazy references.         *
 * ------------------------------------------------------------------ */

/**
 * Descriptor for a single skill: a tiny router-visible trigger stub plus its
 * lazy reference files. Carries only the small, indexable surface — never the
 * deep reference bodies.
 * @typedef {Object} SkillManifest
 * @property {string}   skillId           Unique skill identifier, e.g. 'tdd-debug'.
 * @property {string}   [description]     One-line human summary from frontmatter; the menu surface.
 * @property {string}   triggerFile       Relative path to the trigger stub, e.g. 'skills/tdd-debug/SKILL.md'.
 * @property {string[]} refFiles          Paths to lazy reference files.
 * @property {string[]} triggers          Short trigger phrases from frontmatter.
 * @property {string[]} tags              Tags from frontmatter.
 * @property {string[]} negativeTriggers  Phrases that should NOT match this skill.
 * @property {string[]} [synonyms]        Optional synonyms from frontmatter. Expands the token-overlap
 *                                        matching surface without polluting trigger phrases used for
 *                                        exact-phrase scoring. E.g. ['crashes', 'blows up', 'panics'].
 * @property {number}   [priority]        Optional tiebreaker (default 5). Lower number = higher priority.
 *                                        Used when two skills have equal confidence scores. Orchestrator
 *                                        lane skills should use 1-2; general reference skills use 5+.
 * @property {number}   triggerLineCount  Actual line count of the trigger stub at index time.
 * @property {string}   [source]          Provenance set at merge time: 'plugin' or 'workspace'.
 */

/**
 * Result of scoring one SkillManifest against a query (E4-5). Purely
 * algorithmic — no LLM calls — so routing stays fast and deterministic.
 * @typedef {Object} MatchResult
 * @property {string}   skillId           Matched skill identifier.
 * @property {number}   confidence        0.0-1.0 composite score.
 * @property {string}   reason            Human-readable explanation of why this skill matched.
 * @property {string}   triggerFile       Path to the trigger stub to load.
 * @property {string[]} refFiles          Lazy reference files available for this skill.
 * @property {boolean}  negativeTriggered True if any negative trigger fired (hard exclusion).
 * @property {number}   [priority]        Priority carried from SkillManifest (default 5). Callers may
 *                                        use this to re-sort results after post-processing.
 */

/**
 * Durable workflow-state signals used by the Stage-2 state-conditional re-rank
 * (lib/skills/context-rank.mjs). Assembled at the hook boundary from task.json.
 * @typedef {Object} MatchContext
 * @property {string|null} lane  Active lane ('feature'|'bug'|'chore') or null.
 * @property {string|null} gate  Active workflow gate or null.
 * @property {string[]} [domains]  DN-5: active business-domain ids from the in-pass DN-2
 *                                 resolution (ranked). Readers treat absent as [] — no domain signal.
 * @property {Record<string, string[]>} [domainKeywords]  DN-5: domain id → configured keywords,
 *                                 passed by the hook-boundary caller so context-rank stays pure
 *                                 and never reads config.
 */

/**
 * One skill-match decision, appended to the decision ledger
 * (`.devmate/state/skill-decisions.jsonl`) at the hook boundary. Records the
 * FULL scored candidate list so wrong-winner and below-threshold outcomes are
 * observable, plus the operating point and workflow context. `manifestsLoaded`
 * and `skillsDir` are the loader canary: a value of 0 against a nonexistent
 * `skillsDir` is the empty-catalog bug surfaced as data.
 * @typedef {Object} SkillDecision
 * @property {string}        timestamp        ISO-8601 write time.
 * @property {string}        query            The submitted prompt text.
 * @property {number}        manifestsLoaded  Total manifests scored after merge (canary).
 * @property {string}        skillsDir        Primary (plugin) skills directory (canary).
 * @property {Array<{ source: string, dir: string, count: number }>} sources  Per-root load breakdown (canary): distinguishes an empty plugin catalog (the loader bug) from a workspace with no skills.
 * @property {MatchResult[]} scored           Every candidate, incl. negativeTriggered and below-floor.
 * @property {string[]}      selected         skillIds that passed the operating point.
 * @property {number}        topN             Operating point: max surfaced matches.
 * @property {number}        minConfidence    Operating point: confidence floor.
 * @property {string|null}   lane             Active workflow lane from task.json, or null.
 * @property {string|null}   gate             Active workflow gate from task.json, or null.
 * @property {string|null}   intent           Turn intent if resolved, or null.
 */

// ---- E7-1: regression-suite types ----

/**
 * Summary of a single regression suite run (E7-1). Produced by the eval-runner
 * barrel; individual suites use node:test directly.
 * @typedef {Object} RegressionResult
 * @property {string}   suite     Name of the regression suite.
 * @property {number}   passed    Count of passing cases.
 * @property {number}   failed    Count of failing cases.
 * @property {string[]} failures  Array of failing test names.
 */

// ---- E7-6: issue-quality eval types ----

/**
 * Quality score for a single generated GitHub issue body (E7-6). Pure result —
 * the scorer performs no I/O. `score` is the count of satisfied dimensions (0-5).
 * @typedef {Object} IssueQualityScore
 * @property {string}  issueId               Short identifier for reporting.
 * @property {boolean} titleImperative       Title starts with an approved imperative verb.
 * @property {boolean} problemCited          Background cites a ws*.md ref or an official URL.
 * @property {boolean} hasAcceptanceCriteria At least two bulleted AC items present.
 * @property {boolean} dependencyListed      Dependencies section lists issue numbers or 'None'.
 * @property {boolean} tokenImpactStated     Token/context impact field is non-empty.
 * @property {boolean} contractsInlined      If Dependencies lists any #N, an `## Upstream contracts (inlined)` section with a fenced js block is present. Trivially true when Dependencies is 'None'.
 * @property {boolean} externalClaimsSourced Every inlined-contracts block carries a `Source of truth: #N` provenance line. Trivially true when there is no inlined section.
 * @property {number}  score                 Count of satisfied dimensions, 0-7.
 */

// ---- E8-3: isolated branch/worktree execution types ----

/**
 * Options for creating an isolated git worktree (E8-3). Risky edits run on a
 * throwaway branch + worktree so the main working tree stays clean.
 * @typedef {Object} WorktreeOpts
 * @property {string}  baseRef           Git ref to branch from (e.g. current HEAD).
 * @property {string}  branchName        Name for the throwaway branch.
 * @property {string}  worktreePath      Absolute path where the worktree will be created.
 * @property {number}  [timeoutMs]       Max time before auto-teardown (default 60000).
 * @property {string}  [repoRoot]        Git repo root to operate in (default: devmate repo). Set by tests.
 */

/**
 * Live handle to an isolated worktree (E8-3). `active` flips to false after
 * teardown so repeated teardown calls are safe no-ops.
 * @typedef {Object} WorktreeHandle
 * @property {string}  branchName
 * @property {string}  worktreePath
 * @property {string}  baseRef
 * @property {string}  createdAt         ISO timestamp.
 * @property {boolean} active            False after teardown.
 * @property {string}  repoRoot          Git repo root this worktree was created in.
 */

/**
 * Diff artifact extracted from an isolated worktree (E8-3). `diffText` is capped
 * at 64 KB; the full diff is always written to `artifactPath`.
 * @typedef {Object} WorktreeDiff
 * @property {string}  diffText          Output of `git diff baseRef..branchName` (capped at 64 KB).
 * @property {string}  artifactPath      Path where the full diff was saved.
 * @property {number}  filesChanged
 * @property {number}  insertions
 * @property {number}  deletions
 */

/**
 * Telemetry record appended after an isolated worktree run (E8-3).
 * @typedef {Object} WorktreeTelemetry
 * @property {string}  branchName
 * @property {number}  durationMs
 * @property {number}  filesChanged
 * @property {boolean} cleanedUp
 */

// ---- E8-4: model/budget policy routing types ----

/**
 * A single model entry in the policy config (E8-4). Model IDs must be externally
 * verified against official provider docs before use as a default — an entry with
 * `verifiedAt: null` is treated as `[UNVERIFIED]` and cannot route in production.
 * @typedef {Object} ModelEntry
 * @property {string}      modelId    The model identifier string (must be externally verified).
 * @property {string|null} verifiedAt ISO date the ID was verified against official docs; null = unverified.
 * @property {string}      [source]   URL of official documentation confirming this ID.
 * @property {string}      [notes]
 */

/**
 * Model routing policy keyed by budget class (E8-4). Read from
 * `config/model-policy.json`; no model IDs are hardcoded in committed behavior.
 * The optional `roles` block (FO-7) adds a per-worker-role dimension with the
 * same verification discipline; a policy without it stays valid.
 * @typedef {Object} ModelPolicy
 * @property {number} schemaVersion
 * @property {Record<BudgetClass, ModelEntry>} byBudgetClass
 * @property {Partial<Record<ModelRole, ModelRoleEntry>>} [roles]
 */

/**
 * Result of routing one budget class to a model (E8-4).
 * @typedef {Object} PolicyRoute
 * @property {string}  budgetClass
 * @property {string}  modelId
 * @property {boolean} verified    True only when the entry's verifiedAt is non-null.
 */

// ---- FO-7: per-worker-role model routing types ----

/**
 * A known per-worker model-policy role (FO-7). Role names outside this union
 * are rejected by policy validation (KNOWN_MODEL_ROLES in
 * `lib/routing/model-policy.mjs`).
 * @typedef {'discoveryWorker'} ModelRole
 */

/**
 * A single role entry in the policy config's `roles` block (FO-7). Same
 * verification field rules as `ModelEntry`, plus an optional free-text
 * rationale for why this role gets its own route.
 * @typedef {Object} ModelRoleEntry
 * @property {string}      modelId    The model identifier string (must be externally verified).
 * @property {string|null} verifiedAt ISO date the ID was verified against official docs; null = unverified.
 * @property {string}      [rationale] Why this role routes separately (e.g. read-only search).
 * @property {string}      [source]   URL of official documentation confirming this ID.
 * @property {string}      [notes]
 */

/**
 * Result of routing one worker role to a model (FO-7). Mirrors `PolicyRoute`
 * with the role name in place of the budget class.
 * @typedef {Object} RolePolicyRoute
 * @property {string}  role
 * @property {string}  modelId
 * @property {boolean} verified    True only when the entry's verifiedAt is non-null.
 */

/**
 * Per-role dispatch hint inside the model-route hint file (FO-7). Advisory
 * until the role's model ID is verified AND a committed role baseline exists.
 * @typedef {Object} ModelRouteRoleHint
 * @property {string} modelId
 * @property {'advisory'|'enforced'|'blocked'} mode
 */

/**
 * Shape of the dispatch hint persisted at `.devmate/state/model-route.json`
 * (E9-11; `roles` added by FO-7 — absent when the policy has no roles block).
 * @typedef {Object} ModelRouteHint
 * @property {string}  budgetClass
 * @property {string}  modelId
 * @property {boolean} verified
 * @property {'advisory'|'enforced'|'blocked'} mode
 * @property {string}  recommendedAt
 * @property {Partial<Record<ModelRole, ModelRouteRoleHint>>} [roles]
 * @property {'cheap'|'powerful'} [tier]  Issue 27: advisory cost tier (cheap-vs-powerful) for this route.
 * @property {string} [tierReason]  Issue 27: why that tier was chosen.
 */

// ---- FO-4: discovery artifact fan-in (merge) types ----

/**
 * A discovery claim after fan-in merge (FO-4). Extends the base
 * `DiscoveryClaim` shape (`lib/workflow/agents/discovery.mjs`) with additive,
 * optional metadata — a single-artifact `DiscoveryClaim` remains valid
 * wherever a `MergedDiscoveryClaim` is expected.
 * @typedef {Object} MergedDiscoveryClaim
 * @property {string} fact
 * @property {string} path
 * @property {'high'|'low'} confidence
 * @property {number}   [corroboration]  Distinct source artifacts asserting this claim (>=1).
 * @property {string[]} [sources]        Artifact indices or worker ids (via `opts.workerIds`) that asserted this claim.
 * @property {boolean}  [needsReview]    True when this claim's file still owns >=2 distinct unmerged claims (conflict surfaced, never resolved).
 */

/**
 * The merged discovery artifact `mergeDiscoveryArtifacts` produces — the
 * single artifact downstream consumers (`@tech-design`, `@rubber-duck`,
 * planner) see, so the fan-out stays invisible to the rest of the lane.
 * @typedef {Object} MergedDiscoveryArtifact
 * @property {'discovery'} agentName
 * @property {MergedDiscoveryClaim[]} claims
 * @property {string[]} unverified
 */

/**
 * Options controlling a discovery-artifact fan-in merge (FO-4).
 * @typedef {Object} MergeDiscoveryArtifactsOpts
 * @property {number}   maxClaims          Required, >=1. Overflow claims are demoted to `unverified` entries (never silently dropped).
 * @property {number}   [nearDupThreshold=0.8]  Token-set Jaccard similarity floor (0-1, inclusive) for lexical near-dup merging.
 * @property {string[]} [workerIds]        Optional worker id per input artifact (parallel to `artifacts`); falls back to the artifact's index (as a string) when absent or short.
 */

/**
 * Counts describing what a fan-in merge did — every cap and drop is visible,
 * never silent (mirrors `mergeCandidates`'s `dropped` field, `lib/discovery/scan.mjs:829`).
 * @typedef {Object} MergeDiscoveryStats
 * @property {number} inputClaims    Total claims read from valid input artifacts.
 * @property {number} mergedClaims   Claims present in the final (post-cap) merged artifact.
 * @property {number} exactDups      Claims folded into an existing cluster via exact-match dedup.
 * @property {number} nearDups       Claims folded into an existing cluster via lexical near-dup dedup.
 * @property {number} corroborated   Claims upgraded from `low` to `high` confidence by corroboration (>=2 distinct sources).
 * @property {number} needsReview    Distinct-claim conflict groups surfaced (counted per file, not per claim).
 * @property {number} dropped        Claims cut by the `maxClaims` cap and demoted to `unverified` entries.
 * @property {number} invalidInputs  Input artifacts skipped because they failed `validateDiscoveryArtifact`.
 */

/**
 * Result of `mergeDiscoveryArtifacts` (FO-4) — the discovery-artifact fan-in.
 * @typedef {Object} MergeDiscoveryArtifactsResult
 * @property {MergedDiscoveryArtifact} merged
 * @property {MergeDiscoveryStats} stats
 */

// ---- FO-6: discovery memory (persist merged discovery facts) types ----

/**
 * Options for `writeDiscoveryFacts` (FO-6). Exactly one of `mergedArtifact`
 * or `mergedArtifactPath` must be provided.
 * @typedef {Object} WriteDiscoveryFactsOpts
 * @property {string}  taskId              Validated against TASK_ID_RE (fail-closed).
 * @property {string}  lane                Workflow lane recorded on each fact ('unknown' when absent).
 * @property {MergedDiscoveryArtifact} [mergedArtifact]     In-memory merged artifact (preferred at the merge call site).
 * @property {string}  [mergedArtifactPath] Path (repo-root-relative or absolute) of the merged artifact JSON.
 * @property {string}  [ledgerPath]        Target ledger; defaults to the task ledger for `taskId`.
 * @property {string}  [repoRoot]          Repo root for path resolution and content digests; defaults to cwd.
 * @property {() => number} [now]          Injectable clock (determinism in tests); defaults to Date.now.
 */

/**
 * Result of a `writeDiscoveryFacts` call (FO-6). Every skip is counted,
 * never silent.
 * @typedef {Object} DiscoveryFactsWriteResult
 * @property {boolean}     ok
 * @property {FactEntry[]} facts                The discovery fact entries written (empty on error).
 * @property {number}      staledPrior          Prior discovery facts for this task marked stale (idempotent re-run).
 * @property {number}      skippedNeedsReview   Claims skipped because their conflict was never adjudicated.
 * @property {number}      skippedMissingSource Claims skipped because the referenced file does not exist.
 * @property {number}      skippedInvalid       Claims skipped because they failed shape/path validation.
 * @property {string}      ledgerPath
 * @property {string|null} error                Non-null on failure; nothing was written.
 */

// ---- FO-8: fan-out telemetry report types ----

/**
 * Parallelism achieved during a task's subagent fan-out (FO-8), computed from
 * paired `subagent_start`/`subagent_complete` trace events (paired by stepId).
 * Events whose stepId lacks a counterpart are counted in `unpaired` and
 * excluded from the window/overlap/speedup math.
 * @typedef {Object} FanoutParallelism
 * @property {number}      workers            Paired workers — the K actually used.
 * @property {number}      unpaired           Start/complete events with no matching counterpart (crashed or still-running workers).
 * @property {number}      maxOverlap         Maximum number of paired workers running at the same instant (a shared boundary instant does not overlap).
 * @property {number|null} windowMs           Wall-clock span from first paired start to last paired complete; null when no pairs.
 * @property {number|null} serialEquivalentMs Sum of every paired worker's durationMs — the serial-equivalent cost; null when no pairs.
 * @property {number|null} speedup            serialEquivalentMs / windowMs; null when no pairs or the window is zero-width.
 */

/**
 * Aggregated telemetry for one candidate-scan strategy (FO-8) — ledger entries
 * whose workerId starts with `scan-by-` (the FO-3 strategies).
 * @typedef {Object} FanoutScanStrategy
 * @property {string} workerId       Strategy id, e.g. 'scan-by-content'.
 * @property {number} runs           Telemetry entries recorded for this strategy.
 * @property {number} meanLatencyMs  Mean latencyMs across runs.
 * @property {number} violations     Entries with contractValid === false.
 * @property {number} violationRate  violations / runs, in [0,1].
 */

/**
 * Merge quality read from the task's `discovery_merge` trace event (FO-8).
 * Instrumentation caveat: the event's `inputs` counts worker ARTIFACTS while
 * `merged` counts CLAIMS (`scripts/merge-discovery.mjs`), so the issue-specified
 * dedup formula `(inputs - merged) / inputs` is only computed when the two are
 * comparable (`inputs > 0` and `merged <= inputs`); otherwise `dedupRate` is
 * null and the report notes the gap rather than inventing a number.
 * @typedef {Object} FanoutMergeQuality
 * @property {number}      inputs     Worker artifacts fed into the merge.
 * @property {number}      merged     Claims kept in the merged artifact.
 * @property {number}      dropped    Claims dropped by the maxClaims cap.
 * @property {number}      conflicts  Conflict groups flagged needsReview.
 * @property {number|null} dedupRate  (inputs - merged) / inputs when comparable; null otherwise.
 */

/**
 * Token cost of a task's fan-out, from the worker-telemetry ledger (FO-8).
 * promptTokens are currently recorded as 0 by `fanout` — the report surfaces
 * what exists and notes that gap; it never invents numbers.
 * @typedef {Object} FanoutCost
 * @property {number} totalPromptTokens
 * @property {number} totalCompletionTokens
 * @property {Array<{ workerId: string, completionTokens: number }>} perWorker Completion tokens per worker, largest first.
 */

/**
 * The per-task fan-out report (FO-8) — the join of the task trace and the
 * worker-telemetry ledger that the concurrency-ceiling calibration procedure
 * (docs/parallel-dispatch.md, "Calibrating the ceilings") reads.
 * @typedef {Object} FanoutReport
 * @property {'green'|'yellow'|'red'} verdict Advisory heuristic — see buildFanoutReport's JSDoc for thresholds.
 * @property {string} verdictLine   One-line `K used / max overlap / speedup / dedup rate / violations` summary.
 * @property {FanoutParallelism} parallelism
 * @property {FanoutScanStrategy[]} scan     Per-strategy scan stats, sorted by workerId.
 * @property {FanoutMergeQuality|null} merge Null when the trace holds no discovery_merge event.
 * @property {FanoutCost} cost
 * @property {number} violations             In-window telemetry entries with contractValid === false (all workers, not just scan).
 * @property {number} skipped                Unusable trace events / telemetry entries skipped by the aggregator (never a crash).
 * @property {string[]} notes                Human-readable interpretation, including recorded-gap callouts.
 */

/**
 * PRR-2: one finding raised by the `/devmate-pr-review` skill. Evidence is a
 * pointer (path[, lineRange]) per TCM-3 — never pasted diff content.
 * @typedef {Object} PrReviewFinding
 * @property {'blocker'|'high'|'medium'|'low'|'info'} severity  Impact ranking.
 * @property {'alignment'|'security'|'quality'} category         Lens the finding came from.
 * @property {{ path: string, lineRange?: string }} evidence     Pointer to the offending code (path required).
 * @property {string} finding          What is wrong (one sentence).
 * @property {string} recommendation   Concrete fix or next step.
 * @property {string} [source]         Optional attribution, e.g. a resource-skill id.
 */

/**
 * PRR-2: the typed verdict the `/devmate-pr-review` skill writes to
 * `.devmate/state/pr-review-result.json`. `verdict` is either the literal
 * `APPROVE` or `REQUEST_CHANGES:<non-empty reason>`.
 * @typedef {Object} PrReviewArtifact
 * @property {string} taskId
 * @property {'feature'|'bug'|'chore'} lane
 * @property {1} schemaVersion         Must equal 1 for this version.
 * @property {string} returnedAt       ISO 8601 timestamp of the review.
 * @property {string} contextDigest    diffDigest of the reviewed PrReviewContext (binds verdict to a diff).
 * @property {string} verdict          `APPROVE` or `REQUEST_CHANGES:<reason>`.
 * @property {PrReviewFinding[]} findings
 * @property {{ ok: boolean, outOfScopeFiles: string[], unlistedFiles: string[], missingRegressionTest: boolean }} alignment
 * @property {string[]} unverified     Claims the reviewer could not confirm; every entry starts with `[UNVERIFIED]`.
 */

/**
 * PRR-2: the capped, deterministic review context the `pr-review.mjs` CLI
 * gathers and writes to `.devmate/state/pr-review-context.json`. The raw diff
 * is NEVER embedded — only a capped preview (`diffCapped`), its digest, and a
 * pointer to the full log on disk (`diffFullPath`), per TCM-9.
 * @typedef {Object} PrReviewContext
 * @property {1} schemaVersion
 * @property {string} taskId
 * @property {'feature'|'bug'|'chore'} lane
 * @property {string} workflowGate
 * @property {string} generatedAt      ISO 8601 timestamp (injected clock).
 * @property {PrReviewGit} git
 * @property {PrReviewArtifactRefs} artifacts
 * @property {PrReviewAlignmentSignals} alignmentSignals
 * @property {string[]} resourceSkills  Ids of the resource skills the reviewer should consult.
 */

/**
 * PRR-2: git slice of {@link PrReviewContext}. When `available` is false the
 * diff fields are empty and `note` explains why (no git / detached / no base).
 * @typedef {Object} PrReviewGit
 * @property {boolean} available
 * @property {string} baseRef          Resolved base ref name (e.g. `origin/main`), or ''.
 * @property {string} base             merge-base commit sha, or ''.
 * @property {string} head             HEAD commit sha, or ''.
 * @property {Array<{ status: string, path: string }>} changedFiles  Capped name-status list.
 * @property {string[]} untrackedFiles  Capped list of untracked, non-ignored paths.
 * @property {string} diffDigest       SHA-256 (64 hex) of the full diff output.
 * @property {string} diffCapped       Bounded, secret-redacted diff preview.
 * @property {string} diffFullPath     Absolute path to the full diff log on disk.
 * @property {string} [diffFull]       Full redacted diff — present only when --include-full-output is set.
 * @property {boolean} truncated       True when any capped list overflowed.
 * @property {string} note             Human-readable status/degradation note ('' when clean).
 */

/**
 * PRR-2: recorded planning-artifact references + parsed digests for
 * {@link PrReviewContext}. Each entry records whether the artifact was found
 * and its resolved path so the reviewer can open it on demand.
 * @typedef {Object} PrReviewArtifactRefs
 * @property {{ found: boolean, path: string, acceptanceCriteria: Array<{ id: number, text: string }>, plannedFiles: string[], outOfScope: string[] }} spec
 * @property {{ found: boolean, path: string, taskCount: number, files: string[], assumptions: string[], openRisks: string[], unverified: string[] }} plan
 * @property {{ found: boolean, path: string, lane: string, allowedPaths: string[], allowedGlobs: string[] }} scope
 * @property {{ found: boolean, path: string, bugScope: string, suspectedLayer: string, reproCommand: string }} diagnosis
 * @property {{ found: boolean, path: string, passed: boolean, findingCount: number, unverified: string[] }} security
 */

/**
 * PRR-2: cheap, precomputed alignment signals for {@link PrReviewContext}. The
 * skill keys its per-lane checklist off these so the model does not recompute
 * set differences from the raw diff.
 * @typedef {Object} PrReviewAlignmentSignals
 * @property {string[]} outOfScopeFiles      Changed files failing scope.md (bug/chore).
 * @property {string[]} unlistedFiles        Changed files not in the plan's file set (feature).
 * @property {string[]} plannedButUnchanged  Planned files with no diff (feature).
 * @property {string[]} testFilesChanged     Changed paths matching a test glob (all lanes).
 * @property {boolean} regressionTestPresent True when at least one test file changed.
 */

export {};
