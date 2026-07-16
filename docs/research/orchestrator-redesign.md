# Orchestrator Redesign — Research Report

**Date:** 2026-07-03 · **Verification follow-up:** 2026-07-04
**Method:** Deep-research fan-out — 5 search angles, 23 sources fetched, 109 claims extracted,
top 25 claims put through 3-vote adversarial verification (23 confirmed 3–0, 0 refuted). The
2 claims left unverified when the run hit a session-quota limit mid-verification were
**revisited on 2026-07-04 and both confirmed** — see §7. Findings below are grounded in the
verified claims plus a code-level audit of this repo. Citation markers: **[V]** =
adversarially verified 3–0; **[V*]** = confirmed in the 2026-07-04 follow-up (§7); **[P]** =
primary source, extracted but not adversarially verified; **[B]** = blog/secondary source.

---

## TL;DR

The orchestrator's gate machine (`lib/gate-transitions.mjs`) is genuinely good — the
deterministic transition table, preconditions, and PreToolUse gate guard match how the
strongest frameworks enforce safety. What's broken is the **input side**: the only way a
human gate can advance is a byte-exact phrase matched by `hooks/approval-listener.mjs`, and
the orchestrator prompt has **no instruction for any other input at a gate**. Every leading
tool surveyed — Claude Code, Kiro, LangGraph, the OpenAI Agents SDK, Aider — has converged
on the same architecture: **the LLM interprets free-form human input; deterministic code
validates and executes the resulting transition**. None of them string-match user messages.

Five changes, in priority order:

1. **Off-script-input rules in the orchestrator prompt** — at a human gate, *anything that
   is not explicit approval is revision feedback* (the Kiro rule). Fixes the observed
   failure with zero new infrastructure.
2. **Per-turn state re-anchoring** — repurpose the `UserPromptSubmit` hook from
   phrase-matcher to context-injector: emit current gate, lane, step, pending question, and
   legal next actions into the model's context on every turn (the Claude Code
   system-reminder pattern).
3. **Gate transitions become orchestrator-issued commands** — the model interprets the
   user, then runs `gatectl` (validated by the existing transition table + preconditions +
   trace evidence). Exact phrases stay as an unambiguous fast path, not a requirement.
4. **Per-turn intent classification** — replace the one-shot `@router` with a turn router
   that classifies every message against current workflow state: `new-task | approve |
   revise | steer | question | abandon`.
5. **Robustness evals** — paraphrase-matrix approval tests, interruption tests, `pass^k`
   consistency, end-state grading.

---

## 1. Diagnosis — why the orchestrator gets lost

The reported failure: at the `spec-draft` gate, saying anything other than `approve spec`
or `revise spec: ...` throws the orchestrator off the workflow and it stops dispatching
subagents. The code confirms exactly why, and it is a *design* gap, not a bug:

1. **The approval listener is an exact-match filter.** `hooks/approval-listener.mjs`
   recognizes four literal phrases (`approve spec`, `approve pr`, `revise spec:`,
   `approve no-tdd reason="..."`). Everything else returns `{ action: 'passthrough' }` —
   the gate stays put and nothing tells the model what just happened.
2. **The prompt has no off-script branch.** `agents/orchestrator.agent.md` and the lane
   skills are rigid numbered scripts ("strict 13-step procedure... Hard rules — not
   guidelines"). At step 10 the script says the human "either approves it or asks for
   revisions" — but defines no behavior for a message that is neither phrase. The model
   improvises, and improvisation off a script that forbids improvisation means stalling.
3. **Nothing re-anchors the model to workflow state.** `task.json` holds the durable gate,
   but the orchestrator is never re-shown it on subsequent turns. After a few turns of
   free-form conversation, the lane script has scrolled far behind and there is no
   state-conditioned reminder pulling the model back.
4. **Routing happens exactly once.** `@router` classifies the *first* message. Later
   messages — mid-flight scope changes, approvals-in-other-words, questions — hit an
   orchestrator with no classification step at all.
5. **The run loop ends silently.** An agent run continues until an exit condition — a
   final reply without tool calls ends it [P: OpenAI, *A Practical Guide to Building
   Agents*]. An orchestrator with no instruction for off-script input replies
   conversationally, dispatches nothing, and the run simply ends. That *is* the "stops
   deploying subagents" symptom.

OpenAI's guide names this precise anti-pattern: real interactions create decision points
("a user provides incomplete information or asks an unexpected question") and a robust
routine must anticipate variations with explicit handling instructions [P]. τ-bench exists
because this failure class — agents losing rule-compliance under free-form multi-turn user
interaction — is the documented open weakness of LLM agents [P: arXiv 2406.12045].

**What is *not* broken:** the transition table (`lib/gate-transitions.mjs`), gate
preconditions, the PreToolUse gate guard, dispatch-result validation
(`lib/workflow/orchestrator.mjs`), and trace events. Keep all of it. τ-bench found even
state-of-the-art function-calling agents solve <50% of policy-constrained conversational
tasks with pass^8 <25% [P] — deterministic guards around the LLM are the correct call. The
fix is to stop making determinism do the *understanding*.

---

## 2. Field survey — how the leading tools solve each problem

### 2.1 Nobody string-matches the user. The LLM interprets; code validates.

- **Claude Code (plan mode).** Plan approval is a *model-issued tool call*: the model calls
  `ExitPlanMode` when it judges the plan ready; the harness renders an approve/edit/reject
  UI. A dedicated per-turn system reminder *forbids asking for approval in free text* —
  every plan-mode turn must end in `AskUserQuestion` or `ExitPlanMode` [B: Piebald
  claude-code-system-prompts, extracted from the shipped npm package; corroborated by
  lucumr and how-claude-code-works]. The gate is a tool call plus UI, never a parsed phrase.
- **Kiro (AWS spec agent).** The closest existing analog to DevMate's spec workflow, and
  the most directly reusable pattern. Its production prompt drives requirements → design →
  tasks phases with human review gates, all in prompt rules: the model calls a `userInput`
  tool with phase-specific reason strings (`spec-requirements-review` etc.); approval is
  "a clear 'yes', 'approved', or equivalent affirmative response" — interpreted by the
  model, not matched; and critically, **any gate input that is not explicit approval is
  treated as revision feedback**, mandating a modify-and-re-ask loop until explicit
  approval [B: leaked Kiro system prompt]. Kiro also permits *backward* transitions
  (tasks → design → requirements) when the model infers the user wants upstream changes [B].
- **LangGraph.** Gates are `interrupt()` calls that suspend the graph and persist full
  state via a checkpointer keyed by thread ID [V]. Resumption is
  `Command(resume=<payload>)` where the payload is a typed decision — approve / edit /
  reject / respond — and free-form human feedback rides *inside* the decision (a reject
  carries a feedback message the agent uses to retry differently; a respond feeds the
  human's reply back as the tool result) [V ×3]. Approval-with-edits is one structured
  payload, not two magic strings [V].
- **OpenAI Agents SDK.** Tools declare `needsApproval`; the runtime records an approval
  interruption instead of executing, returns a resumable `RunState`, and the app calls
  `state.approve(interruption)` / `state.reject(interruption)` — rejection carries a
  free-form message returned to the model as the tool result [V* — confirmed 2026-07-04 by
  two independent primary OpenAI sources; see §7]. State serializes to a DB and rehydrates
  later — durable across process restarts [P].
- **Aider.** Explicit chat modes (`/ask` read-only, `/code`, `/architect`) replace approval
  phrases; once context is established, approval is free-form and terse — "go ahead" in
  code mode executes the discussed plan [V ×2].
- **VS Code custom agents.** Sequential workflow steps hand off via declarative `handoffs`
  frontmatter rendering *buttons* with pre-filled prompts — again structured UI, not typed
  phrases [P]. Phase gating is done by per-agent tool restriction (planner gets read-only
  tools) [P].

**Convergent design:** interpretation belongs to the model, validation belongs to code, and
the human is offered a *structured decision surface* (tool call + UI, buttons, typed resume
payloads) rather than a phrase contract. DevMate inverted this: code does the
interpretation (string match) and the model gets no decision structure at all.

### 2.2 Re-anchoring: production agents are steered by state-conditioned injections, not longer scripts

- Claude Code ships ~37 distinct reactive `<system-reminder>` injections — file state,
  context management, task tracking, five plan-mode variants — fired on conversation-state
  conditions, not on a schedule [B: michaellivs; corroborated by Piebald extraction]. The
  plan-mode reminder re-asserts constraints *every turn* and "supersedes any other
  instructions" [B]. Full instructions are re-injected on a throttle (full on turn 1,
  brief on turn 5, refreshed roughly every 25 turns) [B: how-claude-code-works].
- On *re-entering* plan mode, Claude Code injects an explicit re-anchoring instruction:
  read the persisted plan file, reconcile it with the user's current request, then decide
  [B]. The plan itself is a durable markdown file on disk — the planning→execution handoff
  always goes through the filesystem [B: lucumr].
- Anthropic's production multi-agent research system has the lead agent persist its plan to
  external memory at workflow start specifically so truncation can't destroy it, and
  resumes from checkpoints rather than restarting on error [P: Anthropic engineering blog].
- **The hook mechanics make this first-class in Claude Code:** `UserPromptSubmit` cannot
  rewrite the user's message — it can only inject additional context alongside it [V] —
  and `UserPromptSubmit` + `SessionStart` are exactly the events whose stdout is added as
  context the model can see and act on [V]. So DevMate's approval-listener *architecturally
  cannot* translate free phrasing into magic commands, but it *can* re-anchor the model
  with state every single turn. That is the supported pattern [V].

### 2.3 Per-turn intent classification is standard; classify-once is not

- Anthropic's routing pattern: classify an input, direct it to a specialized follow-up;
  appropriate whenever an LLM or lightweight classifier can do it accurately [V].
- NVIDIA's AI-Q blueprint runs an LLM intent classifier as **the entry point for every
  user query** — one structured-JSON call deciding meta-conversation vs. task, plus a depth
  decision (shallow vs. deep machinery) [V ×2]. That is per-turn routing *and* dynamic
  effort scaling in a single node — the direct refutation of DevMate's one-shot router.
- Kiro bakes turn-level intent discrimination into the prompt: "The user may ask questions
  about tasks without wanting to execute them. Don't always start executing tasks in cases
  like this." [B]
- Embedding-based semantic routing (Route objects with example utterances, cosine
  similarity, explicit no-match fallback) offers a 16–100 ms non-LLM fast path [V: aurelio
  semantic-router; B: tianpan]. DevMate already ships a semantic matcher
  (`lib/skills/semantic-matcher.mjs`) used for skill hints — the machinery exists.
- Narrowing the option space before the LLM chooses matters: tool-selection accuracy
  degrades from ~94% at 50 options to ~14% at 741 [B: tianpan — single-source number,
  treat the trend as directional].

### 2.4 Deterministic workflow vs. dynamic agent — Anthropic's line, applied to the lanes

Workflows (predefined code paths) fit well-defined, predictable tasks; agents (model-driven
control) win when flexibility is needed [V]. The orchestrator-workers pattern exists
precisely for tasks where subtasks *can't* be predicted — coding is the canonical example,
and subtasks are "determined by the orchestrator based on the specific input," not
pre-defined [V]. Anthropic's HITL model for agents is conversational and checkpoint-based:
the agent pauses at checkpoints/blockers and itself interprets the human's feedback [V].

Applied to DevMate: the *gate spine* (discovery → grill → plan → spec → impl → verify) is
a legitimate workflow — keep it deterministic. The *conversation around the gates* and the
*implementation decomposition inside `impl-started`* are agent territory — the model should
own interpretation, dispatch sizing, and recovery, within the guardrails.

### 2.5 Dynamic subagent deployment

- Anthropic (production finding): orchestrators can't judge effort without help — embed
  explicit scaling rules in the prompt (1 agent / 3–10 tool calls for simple tasks, 2–4
  subagents for comparisons, 10+ for complex work); without them, early versions spawned
  50 subagents for trivial queries [P].
- Each dispatch needs an explicit objective, output format, tool guidance, and task
  boundaries, or subagents duplicate work and leave gaps [P]. (DevMate's
  `buildDispatchPayload` + worker contracts already point this direction.)
- OpenAI: maximize a single agent first; split only on complex conditional logic or tool
  overload [P]. Invest in tool design ("poka-yoke your tools") — Anthropic spent more time
  on tools than on the overall prompt for their SWE-bench agent [P].

### 2.6 How to test any of this

- τ-bench's paradigm: an LLM-simulated user converses freely; the agent must follow domain
  policy; success is graded by comparing **final state** against an annotated goal state —
  not by matching conversation text [P ×2]. Its `pass^k` metric (same task, k trials, all
  must pass) measures consistency — the exact property DevMate's approvals lack [P].
- Anthropic, same conclusion from production: evaluate end-state, not turn-by-turn process;
  break workflows into discrete state-change checkpoints [P].

---

## 3. Design principles for the new orchestrator

1. **LLM interprets; state machine validates; hooks enforce.** Three layers, each doing
   what it's good at. Never let code guess intent; never let the model bypass a
   precondition.
2. **Default-to-revision, never default-to-approve.** At a human gate, explicit affirmative
   → approve; *everything else* → revision feedback (Kiro). Misclassification then errs
   safe: the worst case is one extra "did you mean approve?" round-trip, never an
   unintended implementation dispatch.
3. **Every turn starts from durable state.** The model is re-shown gate/lane/step/pending
   question each turn. Memory is the filesystem (`task.json`), not the context window.
4. **Structure the decision surface.** Present gates with explicit options (approve /
   revise / ask / abandon) so the human doesn't need to know a phrase contract — and the
   model knows the complete decision vocabulary it must map input onto.
5. **Steering is a transition, not a derailment.** Scope changes map to defined edges
   (re-plan, re-spec, backward transitions) in the gate graph. If the user can say it, the
   graph should have an edge (or an explicit escalation) for it.
6. **Grade robustness on end-state, at k trials, across paraphrases.**

---

## 4. Concrete recommendations

Ordered by leverage-to-effort. R1+R2 alone fix the reported failure.

### R1 — Gate conversation protocol in the orchestrator prompt *(prompt-only; do first)*

Add a **"Human gates — input handling"** section to `agents/orchestrator.agent.md` and both
human-gate steps of the lane skills, transplanting Kiro's rules:

```markdown
## Human gates — input handling (applies at spec-draft and pr-ready)

When presenting a gate artifact, always end by listing the options:
  1. Approve  2. Request changes (just describe them)  3. Ask a question  4. Abandon task

On the next user message, classify it BEFORE doing anything else:
- EXPLICIT approval ("yes", "approve", "looks good", "ship it", or equivalent
  affirmative) → run the gate transition (R3), then continue the lane.
- ANY requested change, correction, addition, or concern — regardless of phrasing,
  and even if not framed as "revise spec:" → this IS revision feedback. Dispatch
  @spec-writer with the feedback, stay in spec-draft, re-present, re-ask.
- A question → answer it from the artifacts, then re-present the gate options.
  Answering a question NEVER advances or abandons the gate.
- Ambiguous between approval and change (e.g. "fine but...") → treat as revision.
  Never infer approval. Approval must be explicit.
- A new unrelated task → confirm: park or abandon the current task first.
You MUST NOT proceed past the gate without explicit approval. You MUST continue the
feedback-revision cycle until you receive it. You MUST NOT stop dispatching subagents
because input didn't match an expected phrase — there is no expected phrase.
```

Grounding: Kiro's explicit-approval + treat-everything-else-as-feedback loop [B]; OpenAI's
"anticipate off-script input with explicit instructions" [P]; Aider's free-form terse
approvals [V].

### R2 — Repurpose the UserPromptSubmit hook: from phrase-matcher to state injector *(highest-leverage code change)*

`approval-listener.mjs` currently acts only when it matches a phrase. Invert it: **always**
emit a state-anchoring context block (stdout is model-visible for this event [V]):

```
<devmate-state>
taskId: T-142 | lane: feature | gate: spec-draft | step: 10/13
pending: human review of .devmate/session/spec.md (presented turn 12)
legal transitions: approve → spec-approved; revise → spec-draft (re-entry)
open assumptions: 2 unverified checkboxes in spec.md
reminder: classify this message per the gate input-handling rules before acting;
free-form change requests are revision feedback; approval must be explicit.
</devmate-state>
```

Sourced from `task.json` + `flattenTransitions()` — both already exist. Emit a variant on
`SessionStart` (session-start.mjs) so resumed/compacted sessions re-anchor, mirroring
Claude Code's plan-mode re-entry instruction ("read the existing plan file, evaluate the
user's current request, decide how to proceed") [B] and its post-compaction reminders [B].
Throttle if token cost matters (full block at gates and every ~5 turns, one-liner
otherwise — the Claude Code cadence [B]).

Keep the existing exact-phrase matching as a *fast path* (it's unambiguous and free), but
it stops being load-bearing.

### R3 — Gate transitions become orchestrator-issued commands *(the tool-call gate)*

Today the hook advances gates behind the model's back; the model can't advance them at all.
Flip it: after interpreting the user per R1, the orchestrator itself runs

```
node scripts/gatectl.mjs workflow set spec-approved \
  --actor human-approval --evidence "<verbatim user message>"
```

Safety comes from the existing machinery, unchanged: `transitionGate()` rejects illegal
edges, `checkGatePrecondition()` rejects unproven ones, the gate guard still blocks
premature source edits, and the `--evidence` field goes into the `gate_transition` trace
event so every approval is auditable back to the exact human words. Add `--actor` +
`--evidence` as required flags for human-gate transitions in `gatectl.mjs`.

This is the pattern everywhere: Claude Code's ExitPlanMode is a model-issued call mediating
approval [B ×3]; Kiro's userInput tool [B]; LangGraph's typed resume decisions [V]; OpenAI's
`state.approve()` API [P]; Anthropic's "invest in the ACI — make tool arguments hard to
misuse" [P]. For extra safety at `pr-ready` (the irreversible-feeling gate), have the
orchestrator use AskUserQuestion-style explicit confirmation when the approval phrasing was
nonstandard.

### R4 — Per-turn intent router *(replaces classify-once)*

Keep `@router` for the *lane* decision, but add a cheap **turn router** that runs on every
message against current state. Two-stage, so cost stays near zero:

- **Stage 1 (deterministic, in the R2 hook, ~0 ms):** exact phrases; and when
  `gate ∈ {no-lane, done}`, trivially `intent: new-task`.
- **Stage 2 (model):** the R2 context block instructs the orchestrator to classify first —
  structured output, NVIDIA AI-Q style [V]:

```json
{ "intent": "new-task | approve-gate | revise-artifact | steer-scope |
             question | status | abandon | chat",
  "confidence": 0.0-1.0,
  "targetArtifact": "spec | plan | diagnosis | pr | null" }
```

Rules mirroring the survey: `question`/`chat`/`status` never mutate gate state (Kiro [B],
AI-Q's meta category [V]); low confidence at a human gate → default `revise-artifact`
(safe); low confidence elsewhere → ask, reusing the router's existing <0.75 escalation
convention. Optionally add an embedding fast path later by extending
`lib/skills/semantic-matcher.mjs` with intent routes + example utterances (semantic-router
pattern, explicit no-match fallback [V]) — worthwhile only if Stage 2 proves too slow.

### R5 — Steering edges in the gate graph *(make interruption a transition)*

The graph already has the right recovery shapes (`spec-draft` re-entry,
`spec-approved → spec-draft` rollback, `spec-invalidated`). Extend `LINEAR_SPINE`/lane
tables with the steering edges users actually exercise, so `steer-scope` intent maps to a
legal move instead of an illegal-transition error:

- `impl-started → spec-draft` (event: `revise-scope`) — scope change mid-implementation:
  fold the change into the spec, re-approve, resume. Preserve `taskId` and completed
  workstreams (the chore-lane escalation rule already sets this precedent: "continue with
  the preserved taskId, never restart").
- `impl-started → plan-done` (event: `re-plan`) — approach change without spec change.
- Any pre-impl gate → earlier gate (Kiro's backward transitions [B]) — e.g. new
  requirements surfacing at `spec-draft` send it back through grill with the delta only.
- `* → parked` (or an `abandoned` terminal) — so "forget this, do X instead" has a clean
  edge and a fresh task can start without a corrupt half-open state.

Each new edge gets a precondition + trace event like the existing ones. This is LangGraph's
lesson expressed in DevMate's idiom: a gate is a durable pause with typed resume options,
and "reject with feedback" loops back into the graph rather than ending it [V ×3].

### R6 — Dynamic dispatch sizing *(inside impl-started and for parallel reads)*

Keep lane order deterministic; free the model *within* steps, with Anthropic's effort-scaling
rules embedded in the prompt [P]:

- `budgetClass: tiny` → single `@fullstack` persona, skip parallel fan-out;
  `standard` → current partitioned dispatch; `large` → orchestrator proposes a workstream
  decomposition (orchestrator-workers: subtasks determined per input, not pre-defined [V])
  bounded by `partitionWorkstreams` + the subagent budget guard as the hard ceiling.
- Require every dispatch prompt to carry objective / output format / tool guidance /
  boundaries [P] — extend `buildDispatchPayload()` to *reject* payloads missing them,
  poka-yoke style [P].
- Don't add more specialist agents to fix conversation problems: split agents only on
  conditional-logic or tool overload [P]. The current 15-agent roster is enough; the gap
  was never headcount.

### R7 — Wire resume into the turn loop

`scripts/resume.mjs` guarantees are right (no repeat work, halted steps need strategy
change) but it's a manual CLI. Have `session-start.mjs` detect an in-flight `task.json`
and inject the resume plan (Claude Code plan-mode re-entry pattern [B]; Anthropic's
resume-from-checkpoint-not-restart [P]); the R4 router then treats the first message as
`continue` vs `new-task` explicitly. An interrupted DevMate task should feel like a
LangGraph interrupted thread: costs nothing while paused, resumable much later with state
intact [V].

### R8 — Robustness evals *(so this never regresses)*

Add to `evals/` alongside the token-estimate suite, using DevMate's own end-state
convention (`task.json` is the database; grade final state, not transcripts — τ-bench [P],
Anthropic [P]):

1. **Approval paraphrase matrix** — ≥30 phrasings ("lgtm", "yep ship it", "approved ✅",
   "sgtm, minor nit but don't block") × expected `spec-approved`; ≥30 revision phrasings
   ("actually also handle the empty-cart case", "hmm, what about auth?", "the plan misses
   migrations") × expected `spec-draft` + spec-writer redispatch. Assert on resulting gate +
   trace events.
2. **Interruption suite** — mid-workflow scope change, question-at-gate, new-task-at-gate,
   abandon-at-gate; assert the R5 edge taken and that subagent dispatch *continues* after.
3. **`pass^k`** — run each scenario k=8; require all-k on gate correctness [P].
4. **Never-approve-by-accident property test** — no phrasing lacking explicit affirmative
   may ever land in `spec-approved` (the safety half of default-to-revision).

The existing `assertDispatchResult` / gate-guard tests keep covering the deterministic
layer; these cover the interpretive layer that has never had coverage.

---

## 5. Phased roadmap

| Phase | Contents | Risk |
| --- | --- | --- |
| **1 — Stop the bleeding** (prompt + hook, no schema changes) | R1 gate-protocol prompt rules; R2 state-injection block in approval-listener + session-start; keep phrases as fast path | Low — additive; exact phrases still work |
| **2 — Structured transitions** | R3 gatectl `--actor/--evidence`; R4 turn-router contract + structured intent output; eval suite R8 items 1 & 4 | Medium — touches gatectl + prompt contract; evals land in the same phase |
| **3 — Steering edges** | R5 new transitions + preconditions + trace events; R7 resume wiring; R8 items 2–3 | Medium — extends the transition tables (well-tested surface) |
| **4 — Dynamic dispatch** | R6 effort scaling + dispatch-payload validation | Low — bounded by existing budget guards |

---

## 6. Source appendix

**Adversarially verified (3–0), 23 claims across:**
LangChain HITL docs · LangGraph interrupts docs · LangChain interrupt blog · Claude Code
hooks docs (code.claude.com) · Aider modes docs · Anthropic *Building Effective Agents* ·
aurelio-labs/semantic-router · NVIDIA AI-Q intent-classifier docs

**Confirmed in the 2026-07-04 follow-up (§7), previously unverified:** OpenAI Agents SDK
HITL guide · LangChain interrupt blog "four HITL patterns" claim.

**Primary, extracted but not adversarially verified:**
OpenAI guardrails/approvals docs · OpenAI *A Practical Guide to Building Agents* (PDF) ·
Anthropic multi-agent research system · VS Code custom agents docs · τ-bench (arXiv
2406.12045)

**Secondary/blog (used for Claude Code internals & Kiro, mutually corroborating):**
Piebald-AI/claude-code-system-prompts (mechanical extraction from the shipped package) ·
lucumr *What is Plan Mode* · Windy3f3f3f3f/how-claude-code-works · yag.xyz plan-mode
reimplementation · michaellivs *System Reminders* · notdp Kiro system-prompt gist ·
tianpan.co intent-classification (sole source for the tool-count accuracy numbers — treat
as directional)

Raw verified-claim payload (quotes + vote counts) preserved from workflow run
`wf_cd887760-1cb`, 2026-07-03.

---

## 7. Verification follow-up (2026-07-04)

The 2026-07-03 run put 25 claims through 3-vote adversarial verification; 23 came back
3–0. The last two panels never returned a vote — they errored on a session-quota limit
(reset 23:20 UTC), so the underlying claims were recorded as "unverified" rather than
refuted. Both were re-checked on 2026-07-04 against reachable primary sources and the
verbatim quotes the original fetch agents had already extracted. **Both confirmed.** Note
that the two source pages named in the claims (`www.langchain.com/blog/…`,
`openai.github.io/openai-agents-js/…`) are now blocked by this session's egress policy
(HTTP 403), so verification used (a) the verbatim quotes captured during the original run
and (b) independent, reachable primary sources.

### 7.1 OpenAI Agents SDK — approval gates are run interruptions → **CONFIRMED**

*Claim:* human approval gates are run interruptions — a tool call needing approval pauses
the run, pending approvals surface in an `interruptions` array, and the run resumes from
the same `RunState`; the gate is a structured pause, not chat-string matching.

- **Verbatim primary quote** (extracted during the run from the OpenAI Agents JS HITL
  guide): *"When a tool call requires approval, the SDK pauses the run, returns
  `interruptions`, and lets you resume later from the same `RunState`."* — a word-for-word
  match to every element of the claim.
- **Independent second primary source** — OpenAI's guardrails/approvals guide
  (`developers.openai.com`, whose 5 claims verified 3–0 in the original run): *"the run
  records an approval interruption instead of executing the tool, returning `interruptions`
  and a resumable `state` … you resume the same run from the `state` rather than starting a
  new user turn,"* plus the code sample `if (result.interruptions?.length) { … state.approve(interruption) … }`.
- **Mechanism corroboration:** approval is declared on the tool (`needsApproval`) and
  resolved by `state.approve()` / `state.reject()` — method calls, not phrase matching.

Two independent primary OpenAI sources, verbatim quotes for every clause. Confidence: high.

### 7.2 LangChain — canonical HITL patterns behind `interrupt()` → **CONFIRMED (substance)**

*Claim:* LangChain/LangGraph identifies a canonical set of HITL patterns that `interrupt()`
supports: (1) approve-or-reject before a critical step, (2) review-and-edit state, (3)
review/edit tool calls before execution, (4) multi-turn conversation / validate human input.

Independently confirmed via the **official LangGraph docs** (`docs.langchain.com/oss/python/langgraph/interrupts`,
retrieved through Context7):

- *"Interrupts enable pausing execution to await external input … These include **approval
  workflows, managing multiple interrupts, reviewing and editing LLM outputs or tool calls,
  and validating human input** before proceeding."*
- Named sections confirm each pattern: **"Approve or reject"** (1), **"reviewing and editing
  LLM outputs"** (2), **"Interrupts in tools" → "human review and editing of the tool
  call's parameters before the tool is executed"** (3), and **"Validating human input"**,
  the re-prompt-until-valid multi-turn pattern (4).

*Nuance:* the exact count "four" is the interrupt **blog's** framing; the official docs list
these patterns plus "managing multiple interrupts" as a use case, so treat the specific
number as blog-authored while the **patterns themselves are confirmed by primary docs**.
This nuance does not affect any recommendation — the report only relies on the existence of
approve/edit/reject/respond-style structured decisions, which is separately verified 3–0
from the LangChain HITL docs.

### 7.3 Net effect on the report

Both follow-up confirmations **strengthen** §2.1 (nobody string-matches the user; the LLM
interprets and code validates) and the R3 recommendation (gate transitions as
orchestrator-issued commands). No finding changed, none was weakened, and no recommendation
depended on either claim in isolation. Verified-claim tally after follow-up: **25 checked →
25 confirmed, 0 refuted, 0 unverified.**

_Follow-up sources: OpenAI Agents JS HITL guide (verbatim quote captured 2026-07-03);
OpenAI guardrails/approvals guide (`developers.openai.com`, verified 3–0); LangGraph
interrupts docs (`docs.langchain.com/oss/python/langgraph/interrupts`) via Context7,
2026-07-04._
