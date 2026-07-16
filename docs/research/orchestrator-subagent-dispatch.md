# Orchestrator Subagent Dispatch — Why It Rarely Delegates, and How to Fix It

**A grounded diagnosis of devmate, backed by 100+ verified sources from the leading practitioners in agentic engineering.**

*Research date: 2026-07-05 · Branch: `claude/orchestrator-subagent-dispatch-ak9wxm`*

This report answers a reported, trust-eroding problem: **the orchestrator rarely dispatches subagents — it does the work inline in the current session, which fills its own context window fast and degrades the model** (hallucination, worse performance). It has two halves:

- **Part I–II** — a code-level diagnosis of *why this happens in devmate specifically*, and a prioritized, low-risk fix, with `file:line` anchors.
- **Part III–IV** — the external evidence base: a deep, fact-checked synthesis of what Anthropic, OpenAI, Cursor, Cognition/Devin, Matt Pocock, and the academic literature say, across **100+ sources**, every key claim adversarially verified (3 independent skeptic votes; a claim needed 2/3 refutes to be dropped).

Citations like `[n]` refer to the numbered bibliography in Parts III–IV.

---

## TL;DR

**The root cause is not the model and not a single bug — it is that delegation in devmate is *100% prompt-driven with no forcing function, and the most prominent instruction actively biases toward inline work.*** Every guard in the system caps *over*-dispatch; nothing anywhere detects or prevents *under*-dispatch. Specifically:

1. **The strongest dispatch guidance points the wrong way.** `agents/orchestrator.agent.md:85-87` tells the model *"The default is to **maximize a single agent first**: dispatch the fewest subagents that can complete the task,"* and `:90-93` says *"tiny → single persona, **skip parallel fan-out**."* An LLM reads this as license to just handle everything itself. This exact phrase — "maximize a single agent first" — is real, defensible advice from OpenAI [21]… but it is meant for *coupled, write-heavy* work, and devmate applies it as a blanket default to **all** work, including the read-heavy analysis (discovery, tech-design, grilling, planning, diagnosis) that every expert agrees *should* be delegated for context isolation [2][43][28].

2. **The only hard "delegate" mandate is narrowly scoped to source edits.** `agents/orchestrator.agent.md:14`: *"Never modify source files directly — all code changes are delegated to `@fullstack`."* Nothing forbids the orchestrator from doing discovery, design, planning, or diagnosis itself — and *that* analysis work is exactly what floods the context window.

3. **Dispatch is entirely voluntary.** There is no code path that can force a subagent to spawn; `lib/orchestrator/fanout.mjs` is standalone scaffolding, never on the real dispatch path (`docs/parallel-dispatch.md:26-33`). The model dispatches only if it chooses to emit an `@agent` call — and the lane steps that instruct it to do so live in on-demand skill refs that scroll out of context after a few turns (a "scrolled-behind" failure the repo already documents at `docs/research/orchestrator-redesign.md:63-66`). This mirrors OpenAI's own Codex finding: **delegation instructions placed only in a skill/config file are ignored unless restated in the live prompt** (openai/codex issue #23496) [31].

4. **The orchestrator is structurally equipped to work inline.** Its own toolset grants `edit` and `execute` (`agents/orchestrator.agent.md:4`). Anthropic's tool-writing guidance says the reliable way to stop a behavior is to remove the affordance, not to ask nicely [77].

5. **Every guard optimizes against the opposite failure.** `hooks/subagent-budget-guard.mjs:90-96` only *caps* concurrent subagents at 3; `lib/gate-guard-core.mjs` only gates *edits*; `assertDispatchResult` only runs *after* a result exists. The docs even describe the guards as protecting against *"an over-eager dispatch"* (`docs/orchestrator-conversation.md:31`) — the exact opposite of the reported bug. **There is no dispatch floor.**

6. **A latent fail-closed bug can force inline work during the whole pre-spec phase.** `hooks/subagent-budget-guard.mjs:77-83` returns `decision:"denied"` whenever `task.json` is unreadable — and `task.json` is not created until *after* plan approval (`agents/orchestrator.agent.md:167`; `scripts/session-start.mjs` never seeds it). So during discovery → tech-design → grill → plan, every `SubagentStart` is denied. Whether the host enforces that deny is host-dependent (the hook always `exit(0)` and only writes the decision to stdout, `:250,:277`), so this is a *conditional* cause and, at minimum, a real fail-closed defect.

7. **The tests pin prose and payload shape, never behavior.** No test asserts a dispatch actually happens, so a fully-inline run passes CI green (`test/agents/orchestrator.feature-lane.test.mjs:54-60` only checks the prompt *mentions* dispatch lines; `test/orchestrator-dispatch-guard.test.mjs` validates a *provided* result's shape).

**The fix is low-risk because it targets the work all camps agree should be isolated.** The multi-agent skeptics (Cognition/Devin [43], the equal-token single-agent paper [67]) argue against parallelizing *coupled writes* — which devmate already keeps single-threaded via `@fullstack`. The reported failure is under-delegation of the **read-heavy pre-spec analysis**, which Anthropic, OpenAI, Cursor, Cognition, and academia *all* classify as the safe, high-value delegation target [2][43][28][37]. So making delegation the default for that work is exactly aligned with the consensus, not a gamble on a contested position.

---

## Part I — Diagnosis: why devmate's orchestrator works inline

Dispatch in devmate is a **prompt behavior with no runtime backstop**. The orchestrator is a 459-line markdown prompt (`agents/orchestrator.agent.md`); its only "spawn a subagent" action is the LLM voluntarily emitting an `@agent` tool call. Confirmed by the repo's own note: *"At the prompt level, `agents/orchestrator.agent.md` instructs the LLM to emit `agent` tool calls… `lib/orchestrator/fanout.mjs` is a separate, standalone Node utility… not involved in Step 2 dispatch"* (`docs/parallel-dispatch.md:26-33`). Because nothing in code requires a dispatch, when the model answers inline, **no guard intervenes** — the failure is invisible to the entire enforcement layer.

The root causes, ranked by leverage (all `file:line`-verified):

| # | Root cause | Evidence | Level | External parallel |
|---|---|---|---|---|
| 1 | Strongest guidance biases toward inline ("maximize a single agent first… skip parallel fan-out") applied as a blanket default to *all* work, including read-heavy analysis | `agents/orchestrator.agent.md:85-93` | Prompt | Right advice, wrong scope — OpenAI's single-agent-first is for *coupled* work [21]; read-heavy analysis is the canonical delegate-for-isolation case [2][43][28] |
| 2 | Only hard delegation mandate is *source edits*; analysis/design/planning/diagnosis inline is never prohibited | `agents/orchestrator.agent.md:14` | Prompt | The context-filling work is precisely the unguarded work [2][4] |
| 3 | Dispatch is 100% voluntary; lane steps live in on-demand skill refs that scroll out of context | `docs/parallel-dispatch.md:26-33`; `docs/research/orchestrator-redesign.md:63-66`; `skills/orchestrator-feature-lane/refs/procedure.md` | Prompt+Code | Codex #23496: skill/config delegation rules are ignored unless in the live prompt [31] |
| 4 | Orchestrator holds `edit`/`execute` tools → structurally able to work inline | `agents/orchestrator.agent.md:4` | Prompt | Remove the affordance, don't ask nicely [77] |
| 5 | No dispatch *floor*; every guard caps *over*-dispatch only | `hooks/subagent-budget-guard.mjs:90-96`; `lib/gate-guard-core.mjs:404-573`; `docs/orchestrator-conversation.md:31` | Code | System is tuned against the *opposite* failure (over-eager dispatch) [43] |
| 6 | Fail-closed budget guard denies dispatch when `task.json` missing (entire pre-spec phase) | `hooks/subagent-budget-guard.mjs:77-83`; `agents/orchestrator.agent.md:167`; `scripts/session-start.mjs` | Code (conditional) | Latent fail-closed defect; violates AGENTS.md rule 5 spirit |
| 7 | Tests pin prose/shape, not behavior — a fully-inline run is green | `test/agents/orchestrator.feature-lane.test.mjs:54-60`; `test/orchestrator-dispatch-guard.test.mjs` | Test | MAST: 41.8% of multi-agent failures are spec/design, not model [59] |

**The single strongest lever** is the effort-scaling prose at `agents/orchestrator.agent.md:85-87`. The phrase *"maximize a single agent first: dispatch the fewest subagents"* is the exact instruction that licenses inline work. Everything else compounds it, but this is the line the model reads as "handle it yourself."

**A contradiction worth naming:** the project's stated differentiator is token/context management "as enforceable state, not prompt-prose advice" (`docs/context-management.md`), yet the *decision to delegate* — the highest-leverage context lever of all — is implemented purely as prompt prose, with the enforcement layer (compaction) only kicking in to rescue an *already-overfull* orchestrator rather than preventing the overfill by delegating in the first place.

---

## Part II — The fix: make delegation the default for read-heavy work

The recommendation is **not** "always delegate" (the experts are explicit that naive multi-agent parallelism harms coupled work [43][67]). It is: **make delegation cheap, legible, and the default for the read-heavy analysis work — and route by task shape.** Prioritized by leverage, mapped to the evidence in Parts III–IV.

### Tier 1 — Forcing functions (highest leverage; fixes the literal bug)

1. **Reframe the Role and effort-scaling prose (`agents/orchestrator.agent.md:12-14`, `:85-93`).** Replace *"maximize a single agent first"* with a task-shape default: *your default action for substantive analysis, design, planning, diagnosis, and implementation is to **delegate to a subagent**; doing that work inline is the exception. Keep only lightweight synthesis, routing, and gate-state in this session.* Scale the *number* of subagents to `budgetClass` — never scale *whether* to delegate. This directly targets root causes 1–2. *(Evidence: Anthropic hard-codes effort-scaling but its default is to delegate exploration to isolated windows [2]; the single most actionable finding.)*

2. **Remove `edit` (and reconsider `execute`) from the orchestrator's `tools` (`agents/orchestrator.agent.md:4`).** This makes inline code-writing *structurally impossible* — the one Tier-1 lever enforceable with zero new code. The orchestrator already delegates all edits to `@fullstack` in principle (`:14`); this makes the principle real. *(Evidence: remove the affordance [77].)*

3. **Add a dispatch *floor* (net-new, the durable fix).** The trace layer already emits a `subagent_start` event on every dispatch (`hooks/subagent-budget-guard.mjs:103-115`). Add a guard that flags a **gate advancing on an analysis step with no `subagent_start` trace event for that step** — the mirror image of the existing `assertDispatchResult`. This turns "delegate" from prose into enforceable state, consistent with how the rest of the system works, and closes root cause 5. *(Evidence: MAST — orchestration/spec failures dominate; verification is the fix [59].)*

4. **Fix the fail-closed bug (root cause 6).** Either seed `task.json` with `{activeSubagents:0}` at `SessionStart` (`scripts/session-start.mjs`) so pre-spec dispatch isn't denied, **or** make `handleSubagentStart` fail *open* (allow, count 0) when `task.json` is absent (`hooks/subagent-budget-guard.mjs:77-83`). Pre-spec analysis is exactly the phase that most needs delegation.

### Tier 2 — Make the sub-task legible (so the model routes to it)

5. **Sharpen each subagent's `description`/handoff into an explicit trigger.** Delegation fires off the subagent description; vague descriptions yield no routing signal. Add "use for X," "use before Y" phrasing to `agents/*.agent.md` descriptions. *(Evidence: description is the routing signal [3][18][37]; small description refinements drove SWE-bench SOTA [77].)*

6. **Keep — and lean on — the summary-only return contract** (`lib/orchestrator/worker-contract.mjs`, `lib/context/output-contract.mjs`). This is already the right design: the subagent burns its own window on the noise and returns a bounded digest. It is the mechanism that makes delegation *reduce* the orchestrator's context rather than move it. *(Evidence: subagents return ~1–2k-token summaries; only the summary enters the parent [2][19].)*

### Tier 3 — Route by task shape (the honest, expert-grounded boundary)

7. **Delegate read-heavy, parallelizable, throwaway-detail work; keep coupled writes single-threaded.** Concretely for devmate's lanes: dispatch **discovery, cross-file analysis, tech-design, grilling/critique, planning, diagnosis, and review** to isolated subagents (their noise never reaches the orchestrator); keep **implementation writes** single-threaded via `@fullstack` with compaction — which devmate already does. This is the one boundary Anthropic, OpenAI, Cursor, and Cognition all agree on [2][43][28][37], and it makes the fix low-risk.

### Tier 5 — Verify (or delegation just adds failure modes)

8. **Turn the prose-pinning tests into behavior-pinning ones.** Add an eval/test asserting a `subagent_start` trace event exists for each analysis step of a lane run — so a fully-inline run *fails* CI. Pair delegation with the existing per-step result validation. *(Evidence: MAST 41.8% spec/design failures [59]; verification keeps lossy summaries honest [52].)*

### Key refinement — delegation only helps if it *isolates* (from the supplemental round)

The supplemental research (Part IV) sharpens one point that changes how you implement the fix. **Delegation and context isolation are separable mechanisms** [90][100][112]: Google's ADK distinguishes a `sub_agent` (runs in the *same* session, inherits the parent's full history) from *agent-as-a-tool* (runs in its *own* clean session that is discarded, returning only a result) [90]; Microsoft draws the identical line between *handoff* (transfers the whole conversation) and *agent-as-tools* (isolated, control returns to the primary) [100]; LangChain calls the isolating variant the "isolate" strategy [112]. Google names the trap directly: the control-preserving pattern (results return to the orchestrator) is *also* the context-accumulating one [91].

**What this means for devmate:** dispatching to a subagent only relieves the orchestrator's context pressure if that subagent runs in its own window and returns a *bounded summary* — not if it dumps a full transcript back. devmate's `lib/orchestrator/worker-contract.mjs` and `lib/context/output-contract.mjs` already enforce summary-only returns, so devmate is on the *isolating* side of this line — **provided** the fix preserves that contract. When implementing Tier-1 change 1, route analysis work to subagents that return digests (as today), never to a mechanism that re-inlines the full sub-transcript. The orchestrator's context still grows by each ~1–2k-token summary [2][19] — far less than the tens of thousands of tokens of inline analysis it replaces, but not zero, which is why Tier-4 compaction on the orchestrator remains worthwhile.

**One honest caveat:** for *well-specified, procedural* tasks, self-orchestration can outperform delegation (Part IV) — and devmate's lanes are scripted procedures. This does **not** rescue the status quo: the context blow-up comes from the *read-heavy, unbounded-output* steps (discovery, cross-file analysis, diagnosis), whose output size is unpredictable — exactly the category where isolation pays off. The narrow, well-specified steps are the ones it's safe to keep inline. Tier-3 task-shape routing already draws the line in the right place.

**What NOT to do:** do not add flat fan-out of many subagents from the orchestrator (fragments its own context and invites the conflicting-implicit-decisions failure Cognition warns about [43]); do not delegate coupled implementation to parallel writers; do not rely on adding more prose to the already-459-line prompt without a code-level floor (root cause 3 shows prose alone scrolls away); do not route analysis to a mechanism that returns full transcripts instead of summaries (that moves context, it doesn't isolate it) [90][100].

---

---

## Part III — External research: the expert evidence base

*Primary-source synthesis across 89 fetched sources (16 search angles), every key claim adversarially verified by 3 independent skeptics; 20/20 survived. Citations [1]–[89] resolve to the "Sources" list at the end of this part. Headings are demoted one level so this research nests under Part III.*

## Why LLM Orchestrators Fail to Delegate — and How to Make Delegation Reliable

*A synthesis of primary guidance from Anthropic, OpenAI, Cursor, Cognition/Devin, practitioner writing (Matt Pocock), and the academic literature, applied to a stage-gated AI coding workflow whose orchestrator does work inline instead of dispatching subagents.*

---

### Executive summary

1. **Delegation's core purpose is context isolation, not parallelism.** A subagent runs in its own fresh context window, explores extensively (tens of thousands of tokens), and returns only a condensed ~1,000–2,000-token summary to the parent — so raw tool output, file reads, and intermediate reasoning never accumulate in the orchestrator's window. When the orchestrator does the work itself, it fills its own window with exactly the context delegation is designed to keep out [2][4][3][19]. *(High confidence — 3/3 supported.)*

2. **Models do not delegate reliably on their own; it has to be engineered.** Anthropic had to hard-code effort-scaling rules into the lead agent's prompt (1 subagent for fact-finding, 2–4 for comparisons, 10+ for complex research) because the model both under-delegates and over-scales without them. This is the single most actionable finding for your problem [2][10]. *(High confidence — 3/3.)*

3. **Whether an orchestrator delegates is governed mostly by tool/subagent *design*, not model capability.** In Claude Code the model decides to delegate primarily from the subagent's `description` field; the default posture is reluctance. The documented fixes are configuration/prompt issues: put the `Agent` tool in `allowedTools` (or the call is denied/falls through), name the subagent explicitly, and write a sharp "when to use it" description [3][18]. *(High confidence — 3/3.)*

4. **Keeping work in one window measurably degrades the model — this is the real cost of not delegating.** LLMs have a finite "attention budget" and suffer "context rot": every frontier model tested degrades as input grows, often well before the window is full and even on trivial tasks [4][68]. Long-context use is U-shaped ("lost in the middle") [58], and accumulating a task turn-by-turn in one thread drops performance ~39%, driven by a ~+112% spike in unreliability [57]. *(High confidence.)*

5. **Delegation is an expensive, deliberate trade-off — often the wrong default.** Agents use ~4× and multi-agent systems ~15× the tokens of a chat; token usage alone explains ~80% of performance variance on Anthropic's eval. It pays off only for high-value, breadth-first, parallelizable work and is explicitly a poor fit for shared-context, tightly-coupled tasks — "most coding tasks" [1][2]. This is *why* coding orchestrators often rationally stay in-session. *(High confidence — 3/3, though the numbers are Anthropic's own internal, un-reproduced evals.)*

6. **OpenAI and Cognition actively counsel restraint, not more delegation.** OpenAI's official guidance is "maximize a single agent first"; split only when instructions fail or tool-selection breaks [21][22]. Cognition ("Don't Build Multi-Agents") argues single-threaded linear agents are often *correct* because reliability comes from continuous shared context, and naive parallel writers make conflicting implicit decisions [43][66]. *(High confidence.)*

7. **The convergent read/write boundary:** delegate read-heavy, parallelizable, throwaway-detail investigation to isolated subagents (so it never enters the main history); keep writes, synthesis, and tightly-coupled reasoning single-threaded, protected by compaction/memory [43][45][2][4]. *(High confidence — Anthropic, Cognition, and LangChain converge independently.)*

8. **The academic literature adds that reliable delegation is a *learned* behavior instruct-tuned models largely lack**, and that ~40%+ of multi-agent failures are orchestration/design errors, not model limits — so delegation must be paired with clear task specs and output verification or it introduces new failure modes [56][59]. *(High confidence.)*

---

### Why orchestrators fail to delegate

The experts identify a small set of compounding root causes. None is "the model is lazy"; the behavior is largely rational or fixable.

**1. Inline completion is the model's default bias.** ReAct's foundational single interleaved reason-act loop rewards continuing the current reasoning trace, so models keep executing subtasks inline [61]. Delegation "intelligence" — knowing *when, what, and how* to hand off — is a learned behavior that default instruct-tuned models largely lack; SearchSwarm shows a model only begins delegating after supervised fine-tuning on trajectories encoding correct handoff decisions [56].

**2. Prompting alone is a weak, lossy lever.** Models internally "know" when a tool/subagent is needed — tool-necessity is linearly decodable from hidden states at AUROC 0.89–0.96, beating their own verbalized reasoning — yet they fail to act on it, and prompt-only steering suppresses necessary calls along with unnecessary ones [74]. The reliable levers are parameter-level (`tool_choice`) and description-based auto-delegation, not prose alone.

**3. Tool-affordance / description problems.** Delegation fires (or doesn't) based on the subagent's `description`. Vague descriptions yield no delegation signal; Anthropic instructs authors to add explicit trigger phrases ("use proactively," "use immediately after," "MUST BE USED") to overcome default reluctance [3][18]. Small tool-description refinements took Claude Sonnet 3.5 to SOTA on SWE-bench Verified — evidence that this is an affordance problem, not a capability gap [77].

**4. Missing forcing functions / configuration gaps.** In Claude Code, if the `Agent` tool is missing from `allowedTools`, invocations are denied (in `dontAsk` mode) or fall through the `canUseTool` callback [3]. In OpenAI Codex the default is deliberately non-delegation: it does the work in the main thread and only spawns subagents when the *live prompt* asks — and this instruction is so load-bearing it is *ignored* when it comes only from a skill or AGENTS.md (OpenAI's own issue #23496) [28][31][32]. So "put the delegation rule in the config file" silently fails.

**5. Mis-scoped tasks / no task contract.** When the lead agent gives subagents vague instructions, they duplicate work or leave gaps. Anthropic's fix was to make the orchestrator emit a self-contained task contract per subagent — objective, output format, tools/sources, explicit boundaries [2][10]. Absent that scaffolding, orchestrators default to under- or mis-delegating.

**6. The cost/latency trade-off makes inline work rational.** Delegation costs ~15× the tokens of a chat and is a poor fit for shared-context, dependency-heavy work like most coding [1][2]. A coding orchestrator that stays in-session is often following the *recommended* default (OpenAI, Cognition) — the failure is only when the window has crossed the degradation threshold and delegation would have helped.

---

### Anthropic

Anthropic's guidance is the clearest primary answer, and it is internally consistent across four artifacts.

**Building Effective Agents [1][13].** The throughline: "find the simplest solution possible, and only increase complexity when needed," because "agentic systems often trade latency and cost for better task performance." Single LLM calls with retrieval are usually enough; deterministic workflows suit well-defined tasks; reserve orchestrator-workers for "complex tasks where you can't predict the subtasks needed" [1]. This reframes under-delegation as partly correct behavior.

**How we built our multi-agent research system [2].** The anchor source for the mechanism and economics:
- Each subagent operates in *its own context window*, explores with tens of thousands of tokens, and "returns only a condensed, distilled summary of its work (often 1,000–2,000 tokens)" — keeping detailed context isolated while the lead agent focuses on synthesis [2].
- The Opus-lead + Sonnet-subagents system beat single-agent Opus 4 by **90.2%**; token usage alone explains **~80%** of eval variance; multi-agent uses **~15×** chat tokens [2].
- Explicit limits: domains "that require all agents to share the same context or involve many dependencies between agents are not a good fit... most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating... in real time" [2][8].
- The delegation *engineering*: effort-scaling rules embedded in the prompt (early versions "spawned 50 subagents for simple queries"), and the task-contract requirement — "Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information" [2][10].

*Caveat: the 90.2% / 80% / 15× figures are Anthropic's own internal, non-peer-reviewed evals, not independently reproduced. The claim is correctly attributed to Anthropic throughout.*

**Effective context engineering [4] & harnesses for long-running agents [14].** Grounds delegation in "context rot" and a finite "attention budget" — as tokens grow, recall and long-range reasoning decline "across all models" [4]. The prescribed toolkit for work that *must* stay in the main thread: compaction (server-side, default 150k-token trigger [16]), tool-result clearing / context editing (default 100k trigger, keep last 3 tool uses; 70k→25k example [17]), structured note-taking/memory [81], and full context resets with "handoff artifacts" — needed because compaction alone left Sonnet 4.5 with documented "context anxiety" [14].

**Claude Code subagents / Agent SDK [3][18][19].** The direct mechanistic and troubleshooting source. "Context isolation" is the first-listed benefit; "only its final message returns to the parent" so "the main agent's context grows by that summary, not by the full subtask transcript" [19]. The explicit "Claude not delegating to subagents" fix list: (1) add `Agent` to `allowedTools`; (2) name the subagent in the prompt; (3) write a clear when-to-use description [3]. *(Minor nuance: the description is the decisive lever but not the sole input — automatic delegation also weighs the request's task description and current context [18].)*

---

### OpenAI (Agents SDK / Codex)

OpenAI's distinctive contribution is that **restraint is the official default**, and that the two delegation primitives behave *oppositely* on context.

**Single-agent first [21].** "The general recommendation is to maximize a single agent's capabilities first... often a single agent with tools is sufficient." Split only on concrete, falsifiable triggers: when the agent "fail[s] to follow complicated instructions or consistently select[s] incorrect tools," or when a prompt accumulates too many if-then-else branches [21]. Remedy: scope each specialist to its domain tools ("overloading a single agent... leads to shallow, generic outputs") and run specialists in parallel [25].

**Two primitives, opposite context behavior [23][24][25].**
- *Agents-as-tools (manager pattern):* keeps a single thread of control; via `custom_output_extractor` returns only a distilled result, isolating the sub-agent's transcript — this protects the main window.
- *Handoffs:* the new agent "gets to see the entire previous conversation history" — context is **moved/inherited, not forked clean**, and only trimmed via `input_filters`. So a naive handoff can *preserve or worsen* bloat [23]. Delegation only relieves context pressure when done as isolated tool-calls with output extraction [24][25]. *(Refinement: `agent.as_tool()` already isolates the transcript by default; `custom_output_extractor` is optional further distillation.)*

**Codex: non-delegation by default, and the config trap [28][31][32].** Codex does the work in the main thread and only spawns subagents when the live prompt explicitly asks. Critically, a delegation directive placed only in a skill/AGENTS.md is ignored unless restated in the prompt (issue #23496) — a primary reason orchestrators keep filling their own context [31]. Prescribed discipline: start single-agent; keep a non-coding manager whose only job is plan/delegate/monitor/integrate; delegate parallelizable, read-heavy, bounded subtasks; cap fan-out and nesting at what you can verify (defaults `max_threads=6`, `max_depth=1`) because each subagent costs tokens and latency; and use durable markdown project memory plus per-milestone verification for long-horizon coherence [28][29]. The mechanism (own context window + summary return, avoiding "context pollution") is documented [28] and echoed by Willison [34].

> **Contested / lower-confidence flag:** The claim that context pollution "measurably degrades long-horizon planning" leans on arXiv:2601.14914 (*CodeDelegator*) [33]. One verifier could not confirm this preprint's web footprint (possible fabricated ID); another found it and cites specific numbers (38.4% vs ~26% on MCPMark). Treat the *specific measured magnitude* as single-source and unverified; the underlying phenomenon is independently well-established by [68][57][58].

---

### Cursor

Cursor's product is essentially a running answer to the problem. It ships three delegation mechanisms: **Plan Mode** (any task touching more than a few files starts with a reviewable Markdown plan) [36][35], **Subagents** (each in its own context window, returning only a summary) [37], and **/multitask + git-worktree background agents** running in parallel [38].

The decision-relevant mechanics, drawn from Cursor's own docs [37]: "The description field is your routing signal. Agent reads it when deciding whether to delegate" — vague descriptions ("helps with coding") give no signal; write it "like a job description." Cursor's docs confirm each subagent "has its own context window," intermediate output "stays in the subagent," and "the parent only sees the final summary" [37]. Addy Osmani and Cursor both recommend **hierarchical delegation** — rather than one orchestrator spawning six subagents (which fragments its own context), spawn a couple of "feature leads" that each spawn specialists, so the parent only ever talks to two agents [40].

> **Contested / lower-confidence flags:**
> - The phrase "preserve the parent's planning capacity" is *not* Cursor's wording — it originates from the third-party AgentPatterns.ai [39], not Cursor docs, which say "preserve context in the main conversation." The mechanism is real; the specific quote is a misattribution.
> - "Delegation is *the primary* defense against context degradation" is framing from a vendor marketing blog [42]; Anthropic treats subagents as *one of three* co-equal techniques (with compaction and note-taking) [4].
> - The "launches 3 instead of 4 parallel subagents unless you write the count explicitly" detail rests on a single unconfirmed community bug report [41] and is Cursor-implementation-specific — treat as anecdotal, though it illustrates the general "specify parallelism explicitly" principle documented in [37].

---

### Cognition / Devin — the contrarian view

Cognition's "Don't Build Multi-Agents" [43][66] is the strongest dissent, and it reframes the whole problem: **an orchestrator doing write-work in one continuous thread is often the *correct* default**, not a failure.

Their two principles: (1) *share full context/traces* — subagents don't see each other's full traces; (2) *actions carry implicit decisions* — parallel writers make conflicting implicit assumptions that compound into incoherent results. Reliability comes from continuous shared context ("context engineering"), so naive delegation fragments context and produces conflicting decisions [43][46][47].

Their prescribed fixes are the inverse of "delegate more":
- The right remedy for a filling window is **compressing history** with a dedicated (optionally fine-tuned) summarizer model to keep *one coherent thread* — not spawning parallel writers [43].
- Where delegation *is* safe: **read-only / "intelligence-only" subagents** (parallel search, research, review — a "smart friend") that never write. Keep writes single-threaded [43].

Cognition, Anthropic, and LangChain independently converge on this **read-vs-write boundary** [43][45][2]. Cognition also warns that making delegation *too easy* is a trap — the affordance to design is context-*sharing*, not just spawn-ability.

---

### Matt Pocock / practitioner community

Pocock supplies the sharpest mechanistic mental model. LLM sessions have a **"smart zone"** (early, sharp recall) that degrades into a **"dumb zone"** as the window fills — commonly ~125K–150K tokens on frontier models — caused by **attention degradation**: each token's attention budget is fixed but token relationships grow quadratically, so "the model doesn't forget — the signal gets lost in the noise" [50][55][75].

His prescribed fix is **delegation-for-isolation**: spawn subagents whose sole purpose is to "burn their own disposable context window on the noise and report back" only the short result. Subagents "exist to isolate context, not to compose hierarchies" — the tree is one level deep [49][75][78].

His crucial honest counter-point — and part of *why* engineers resist delegating — is that a subagent's report is a **"secondary source": lossy by construction**, so whatever the subtask omits is invisible to the parent. Delegation trades fidelity for headroom [52]. His mitigation: make well-formed summaries that carry a "context pointer" back to the primary, and verify against the primary (with evals) when detail matters. His tooling operationalizes this: **sandcastle** (parallel sandboxed planner/implementation/reviewer/merger over git worktrees) [51] and **evalite** for verification [54], all framed through Anthropic's workflow-vs-agent lens [53].

---

### Academia

The peer-reviewed and arXiv literature converges on a three-part story.

**Why orchestrators execute inline:** delegation is a *learned* behavior default models lack (SearchSwarm) [56]; ReAct's single interleaved reason-act loop biases toward continuing to act [61]; models "know" a tool is needed but under-act on it [74].

**Why one growing session degrades:** long-context recall is U-shaped ("Lost in the Middle") and decays with length even in long-context models [58]; NoLiMa and RULER show advertised context vastly overstates *effective* context [71][72]; accumulating a task turn-by-turn drops performance **~39%**, driven by a **+112%** rise in unreliability and premature, unrecoverable commitment [57]; reasoning degrades as a "soft cost" before the window is full [65].

**The recommended fix:** explicit hierarchical planner→executor architectures with context-isolated subagents that return distilled summaries, so the orchestrator's context doesn't grow with task complexity — AgentOrchestra reaches ~89% on GAIA and degrades most gracefully on hard multi-stage tasks [60]; SemaClaw calls context isolation an underappreciated benefit of subagents [64]; HuggingGPT is the classic planner-delegator [62].

**The critical caveat — orchestration is the hard part:** MAST ("Why Do Multi-Agent LLM Systems Fail?") finds the dominant failure sources are **specification/design (41.8%)** and **inter-agent misalignment (36.9%)**, not raw model capability [59]. And most multi-agent "wins" are a **test-time-compute confound** — held to equal thinking-token budgets, single agents match or beat multi-agent systems on multi-hop reasoning [67], and each hand-off can only lose information (Data Processing Inequality). Anthropic's own "token usage explains ~80% of variance" supports this: more agents mostly means more tokens [2][67]. A counterpoint from healthcare shows orchestrated multi-agent *sustaining* accuracy under clinical-scale load where a single agent collapses [70] — consistent with the read-heavy/parallelizable boundary.

---

### Context-window degradation — the cost of NOT delegating

This is the empirical spine of the whole problem: doing the work inline is not neutral; it actively poisons the orchestrator's own window.

- **It's universal, not an edge case.** Chroma's context-rot study: all 18 frontier models tested (incl. GPT-4.1, Claude 4, Gemini 2.5) degrade as input grows — often 13.9%–85% drops — beginning well before the window is full and even on trivial retrieval/replication tasks [68][4].
- **The decay is non-uniform.** Information in the *middle* of a long context is used far worse than at the ends (U-shaped "lost in the middle") [58], so an orchestrator doing everything inline buries early instructions and intermediate results in the low-attention middle.
- **The mechanism.** A finite attention budget diluted by n² token interactions [4][50]; "effective" context is a fraction of the advertised window [71][72].
- **The behavioral cost.** Multi-turn accumulation drops task performance ~39% via a +112% unreliability spike and premature commitment [57]; Anthropic documents the same as "context rot" and "context anxiety" requiring resets [4][14].
- **Why isolation fixes it.** Subagents with separate clean windows sidestep single-window degradation; Anthropic attributes most of its ~90% multi-agent gain to distributing work across independent context windows [2] — while cautioning it only pays off for parallelizable, breadth-first work, not tightly-coupled coding [2].

---

### Recommendations / design principles

Prioritized, concrete levers for making your orchestrator delegate reliably — *and* for knowing when it correctly shouldn't.

#### Tier 1 — Forcing functions (highest leverage, fixes the literal bug)

1. **Auto-approve the delegation tool.** Ensure the `Agent`/`Task` (or `spawn_agent`) tool is in `allowedTools` / auto-approved. If it isn't, calls are denied or fall through — this alone can explain "never delegates" [3].
2. **Don't rely on config-file rules.** Delegation instructions in a skill/AGENTS.md/system prompt are demonstrably ignored unless restated where the model acts. Bake the delegation directive into the *live orchestration prompt*, not just static config [31][32]. If your harness supports it, use parameter-level forcing (`tool_choice`) for the cases that must delegate [74].
3. **Write descriptions as explicit triggers.** Treat each subagent's `description` as a routing signal: job-description-specific, with trigger phrases ("use proactively," "MUST BE USED for X," "use immediately after Y") [3][18][37]. Under-delegation is largely a description problem [77].

#### Tier 2 — Make the orchestrator's job "write a good sub-task spec"

4. **Require a self-contained task contract per subagent:** objective, output format, tools/sources, explicit boundaries. Vague briefs cause duplication and gaps [2][10].
5. **Enforce a summary-only return contract.** The subagent does noisy work in its own window and returns a bounded summary (~1–2k tokens); this is what protects the parent [2][19]. Budget/truncate large tool results (~25k cap, pagination) so a single tool call doesn't flood context [77].
6. **Embed effort-scaling rules** with concrete counts (e.g., 1 for lookups, 2–4 for comparisons, more only for genuinely complex work) to stop both under-delegation and over-scaling [2][10]. Specify parallelism counts explicitly [37][41].

#### Tier 3 — Architecture: match the pattern to the task

7. **Default to a single linear agent for coupled/iterative/write-heavy work** — most coding. This is the correct default per Anthropic, OpenAI, and Cognition, not a failure [1][21][43].
8. **Delegate the read-heavy, parallelizable, throwaway-detail work** — codebase exploration, research, test triage, log/diff analysis, review — where the intermediate detail is disposable and the return is a small summary [2][43][28]. This is exactly the isolation your degraded orchestrator needs.
9. **Keep writes single-threaded.** Extra agents should contribute *intelligence, not actions*; parallel writers make conflicting implicit decisions [43][45].
10. **Use hierarchy, not flat fan-out.** If you must scale, spawn a small number of "feature leads" that each spawn specialists, so the parent's context stays clean; cap nesting/fan-out at what you can verify [40][29].
11. **Prefer agents-as-tools over handoffs** for context protection: a manager keeps one thread and returns distilled output; a naive handoff inherits the full history and can worsen bloat [23][24][25].

#### Tier 4 — For work that must stay in the main thread

12. **Layer context management:** compaction (~150k default trigger), tool-result clearing / context editing (~100k trigger, keep last N), structured note-taking/memory, and full resets with handoff artifacts for very long runs [4][14][16][17][81]. Cognition specifically recommends a dedicated summarizer over spawning writers [43].

#### Tier 5 — Verify (or delegation adds failure modes)

13. **Pair delegation with output verification and per-milestone checks** (tests/lint/typecheck; evals against the primary source). ~40%+ of multi-agent failures are orchestration/spec errors, not model limits — verification is what keeps lossy "secondary source" summaries honest [59][52][54][29].

#### Where the experts genuinely disagree

| | Multi-agent advocates (Anthropic research, AgentOrchestra, clinical study) | Skeptics (Cognition/Devin, single-agent-under-equal-tokens paper) |
|---|---|---|
| Core claim | Isolated subagents add capacity and sustain accuracy under load [2][60][70] | Single-threaded shared context is more reliable; multi-agent wins are a token confound [43][67] |
| When right | Parallelizable, read-heavy, breadth-first tasks exceeding one window | Coupled, write-heavy, dependency-laden tasks (most coding) |
| Fix for full context | Delegate to isolated windows | Compress with a summarizer; keep one thread |

**The deciding condition is not model quality but task shape.** Both sides agree on the read-vs-write, independent-vs-coupled boundary. For a **stage-gated AI coding workflow**, most implementation stages are coupled writes → keep them in a single linear agent with compaction. The high-value delegation targets are the *read-heavy gates*: research/exploration, cross-file analysis, test/lint triage, and review — dispatch those to isolated subagents so their noise never reaches the orchestrator's window. That is the honest, expert-grounded fix: not "always delegate," but **make delegation cheap and legible (Tier 1–2), and route by task shape (Tier 3).**

---

### Sources

[1] Building Effective Agents — Erik Schluntz and Barry Zhang / Anthropic — https://www.anthropic.com/engineering/building-effective-agents
[2] How we built our multi-agent research system — Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel Ford / Anthropic — https://www.anthropic.com/engineering/multi-agent-research-system
[3] Subagents in the SDK (Claude Agent SDK / Claude Code documentation) — Anthropic — https://code.claude.com/docs/en/agent-sdk/subagents
[4] Effective context engineering for AI agents — Anthropic Applied AI team — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[5] Building effective agents (commentary) — Simon Willison — https://simonwillison.net/2024/Dec/20/building-effective-agents/
[6] Codingscape summary of Anthropic's multi-agent research findings (X/Twitter) — Codingscape — https://x.com/codingscape/status/1937503477971697684
[7] Anthropic: How we built our multi-agent research system (notes) — Simon Willison — https://simonwillison.net/2025/Jun/14/multi-agent-research-system/
[8] Anthropic Deploys Multiple Claude Agents for 'Research' Tool - Says Coding is Less Parallelizable — Slashdot editorial (msmash) — https://developers.slashdot.org/story/25/06/21/0442227/anthropic-deploys-multiple-claude-agents-for-research-tool---says-coding-is-less-parallelizable
[9] Context Engineering for Agents — Lance Martin (LangChain) — https://rlancemartin.github.io/2025/06/23/context_engineering/
[10] Building a Multi-Agent Research System for Complex Information Tasks (Anthropic case study) — ZenML (LLMOps Database) — https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks
[11] Anthropic's multi-agent system overview a must read for CIOs — Constellation Research analyst — https://www.constellationr.com/blog-news/insights/anthropics-multi-agent-system-overview-must-read-cios
[12] How Anthropic Built a Multi-Agent Research System — ByteByteGo (Alex Xu team) — https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent
[13] Building Effective AI Agents — Anthropic (Erik Schluntz, Barry Zhang) — https://www.anthropic.com/research/building-effective-agents
[14] Effective harnesses for long-running agents — Anthropic (engineering team) — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
[15] Context engineering: memory, compaction, and tool clearing (Claude Cookbook) — Anthropic — https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
[16] Compaction (Claude API documentation) — Anthropic — https://platform.claude.com/docs/en/build-with-claude/compaction
[17] Context editing / tool-result clearing (Claude API documentation) — Anthropic — https://platform.claude.com/docs/en/build-with-claude/context-editing
[18] Subagents (Claude Code) — Anthropic — https://code.claude.com/docs/en/sub-agents
[19] How the agent loop works — Claude Agent SDK — Anthropic — https://code.claude.com/docs/en/agent-sdk/agent-loop
[20] Agent SDK Overview — Anthropic — https://code.claude.com/docs/en/agent-sdk/overview
[21] A Practical Guide to Building Agents — OpenAI — https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
[22] Orchestrating multiple agents (Agents SDK docs) — OpenAI — https://openai.github.io/openai-agents-python/multi_agent/
[23] Handoffs (Agents SDK docs) — OpenAI — https://openai.github.io/openai-agents-python/handoffs/
[24] Tools — Agents as tools (Agents SDK docs) — OpenAI — https://openai.github.io/openai-agents-python/tools/
[25] Multi-Agent Portfolio Collaboration with the OpenAI Agents SDK (Cookbook) — OpenAI (Cookbook contributors) — https://cookbook.openai.com/examples/agents_sdk/multi-agent-portfolio-collaboration/multi_agent_portfolio_collaboration
[26] Swarm — Educational multi-agent orchestration framework (README) — OpenAI Solutions team (incl. Ilan Bigio) — https://github.com/openai/swarm
[27] Agents (Agents SDK docs) — OpenAI — https://openai.github.io/openai-agents-python/agents/
[28] Subagents – Codex — OpenAI (developers.openai.com) — https://developers.openai.com/codex/subagents
[29] Run long horizon tasks with Codex — OpenAI (developers.openai.com) — https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
[30] Introducing the Codex app — OpenAI — https://openai.com/index/introducing-the-codex-app/
[31] Skill instructions to use subagents are ignored unless repeated in the prompt (Issue #23496) — openai/codex community — https://github.com/openai/codex/issues/23496
[32] Add opt-in autonomous delegation setting for subagent-heavy workflows (Issue #18513) — openai/codex community — https://github.com/openai/codex/issues/18513
[33] CodeDelegator: Mitigating Context Pollution via Role Separation in Code-as-Action Agents — Tianxiang Fei, Cheng Chen, Yue Pan, Mao Zheng, Mingyang Song, et al. — https://arxiv.org/abs/2601.14914
[34] Use subagents and custom agents in Codex — Simon Willison — https://simonwillison.net/2026/Mar/16/codex-subagents/
[35] Best practices for coding with agents — Cursor Team (Anysphere) — https://cursor.com/blog/agent-best-practices
[36] Introducing Plan Mode — Cursor Team (Anysphere) — https://cursor.com/blog/plan-mode
[37] Subagents (Cursor Docs) — Cursor Team (Anysphere) — https://cursor.com/docs/subagents
[38] Worktrees / Cursor 2.0 parallel agents (Cursor Docs + release) — Cursor Team (Anysphere) — https://cursor.com/docs/configuration/worktrees
[39] Cursor /multitask: Async Subagent Dispatch in the Editor — AgentPatterns.ai — https://www.agentpatterns.ai/tools/cursor/multitask-subagents/
[40] The Code Agent Orchestra — what makes multi-agent coding work — Addy Osmani — https://addyosmani.com/blog/code-agent-orchestra/
[41] Subagents don't maximize parallel dispatch (bug report) — Cursor community — https://forum.cursor.com/t/subagents-dont-maximize-parallel-dispatch/152679
[42] Context Rot in AI Coding Agents: What It Is and How to Fix It — MindStudio — https://www.mindstudio.ai/blog/context-rot-ai-coding-agents-explained
[43] Don't Build Multi-Agents — Walden Yan / Cognition AI (makers of Devin) — https://cognition.com/blog/dont-build-multi-agents
[44] Multi-Agents: What's Actually Working — Walden Yan / Cognition AI — https://cognition.com/blog/multi-agents-working
[45] How and when to build multi-agent systems — Harrison Chase / LangChain — https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
[46] Why Cognition does not use multi-agent systems — Jason Liu — https://jxnl.co/writing/2025/09/11/why-cognition-does-not-use-multi-agent-systems/
[47] The Age of Async Agents — Cognition's Walden Yan & OpenInspect's Cole Murray (Latent Space) — swyx / Latent Space — https://www.latent.space/p/cognition
[48] Single vs Multi-Agent System? — Philipp Schmid — https://www.philschmid.de/single-vs-multi-agents
[49] AI Coding Dictionary — Subagent, Handoff, Compaction, AFK (source repo) — Matt Pocock — https://github.com/mattpocock/dictionary-of-ai-coding
[50] Smart zone / Dumb zone (AI Coding Dictionary) — Matt Pocock / AI Hero — https://www.aihero.dev/ai-coding-dictionary/smart-zone
[51] Sandcastle: Orchestrate sandboxed coding agents in TypeScript — Matt Pocock — https://github.com/mattpocock/sandcastle
[52] handoff: Move Context Between Agent Sessions — Matt Pocock / AI Hero — https://www.aihero.dev/skills-handoff
[53] Anthropic thinks you should build agents like this (workflow vs agent) — Matt Pocock / AI Hero — https://www.aihero.dev/building-effective-agents
[54] Evalite v1 Preview: Fast Evals, Built-in Scorers — Matt Pocock / AI Hero — https://www.aihero.dev/evalite-v1-preview
[55] Matt Pocock: Why AI Coding's 'Smart Zone' Is Only 100K Tokens — BigGo Finance — https://finance.biggo.com/news/e7209c094224b09c
[56] SearchSwarm: Towards Delegation Intelligence in Agentic LLMs for Long-Horizon Deep Research — SearchSwarm authors — https://arxiv.org/abs/2606.09730
[57] LLMs Get Lost In Multi-Turn Conversation — Philippe Laban, Hiroaki Hayashi, Yingbo Zhou, Jennifer Neville — https://arxiv.org/abs/2505.06120
[58] Lost in the Middle: How Language Models Use Long Contexts — Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua, Fabio Petroni, Percy Liang — https://arxiv.org/abs/2307.03172
[59] Why Do Multi-Agent LLM Systems Fail? — Mert Cemri, Melissa Z. Pan, Shuyi Yang, et al. (UC Berkeley) — https://arxiv.org/abs/2503.13657
[60] AgentOrchestra: A Hierarchical Multi-Agent Framework for General-Purpose Task Solving — Zhang et al. — https://arxiv.org/abs/2506.12508
[61] ReAct: Synergizing Reasoning and Acting in Language Models — Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, Yuan Cao — https://arxiv.org/abs/2210.03629
[62] HuggingGPT: Solving AI Tasks with ChatGPT and its Friends in Hugging Face — Yongliang Shen, Kaitao Song, Xu Tan, Dongsheng Li, Weiming Lu, Yueting Zhuang — https://arxiv.org/abs/2303.17580
[63] Understanding the Planning of LLM Agents: A Survey — Xu Huang, Weiwen Liu, Xiaolong Chen, Xingmei Wang, Hao Wang, Defu Lian, Yasheng Wang, Ruiming Tang, Enhong Chen — https://arxiv.org/abs/2402.02716
[64] SemaClaw: A Step Towards General-Purpose Personal AI Agents through Harness Engineering — SemaClaw authors — https://arxiv.org/abs/2604.11548
[65] LLM-as-Code: Agentic Programming for Agent Harness (soft cost of context) — LLM-as-Code authors — https://arxiv.org/abs/2606.15874
[66] Don't Build Multi-Agents — Walden Yan (Cognition / Devin) — https://cognition.ai/blog/dont-build-multi-agents
[67] Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets — Dat Tran, Douwe Kiela — https://arxiv.org/abs/2604.02460
[68] Context Rot: How Increasing Input Tokens Impacts LLM Performance — Kelly Hong, Anton Troynikov, Jeff Huber (Chroma Research) — https://research.trychroma.com/context-rot
[69] How and when to build multi-agent systems — LangChain team — https://blog.langchain.com/how-and-when-to-build-multi-agent-systems/
[70] Orchestrated multi agents sustain accuracy under clinical-scale workloads compared to a single agent — Eyal Klang, Mahmud Omar, Ganesh Raut, Reem Agbareia, Prem Timsina, Robert Freeman, Lisa Stump, Alexander Charney, Benjamin S. Glicksberg, Girish N. Nadkarni — https://www.nature.com/articles/s44401-026-00077-0
[71] NoLiMa: Long-Context Evaluation Beyond Literal Matching — Ali Modarressi, Hanieh Deilamsalehy, Franck Dernoncourt, Trung Bui, Ryan A. Rossi, Seunghyun Yoon, Hinrich Schütze — https://arxiv.org/abs/2502.05167
[72] RULER: What's the Real Context Size of Your Long-Context Language Models? — Cheng-Ping Hsieh, Simeng Sun, Samuel Kriman, Shantanu Acharya, Dima Rekesh, Fei Jia, Yang Zhang, Boris Ginsburg (NVIDIA) — https://arxiv.org/abs/2404.06654
[73] Tool use with Claude (Overview) — Anthropic — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
[74] LLM Agents Already Know When to Call Tools -- Even Without Reasoning — Chung-En Sun, Linbo Liu, Ge Yan, Zimo Wang, Tsui-Wei Weng (Trustworthy ML Lab, UCSD) — https://arxiv.org/abs/2605.09252
[75] AI Coding Dictionary (subagent, compaction, context isolation) — Matt Pocock / aihero.dev — https://www.aihero.dev/ai-coding-dictionary
[76] Cursor agent system prompt (leaked production prompt) — Cursor (leaked; archived by jujumilk3) — https://github.com/jujumilk3/leaked-system-prompts/blob/main/cursor-ide-sonnet_20241224.md
[77] Writing effective tools for AI agents — using AI agents — Anthropic (Ken Aizawa and Applied AI / engineering team) — https://www.anthropic.com/engineering/writing-tools-for-agents
[78] Workflow for AI Coding / subagents isolate context (aihero.dev writing) — Matt Pocock / AI Hero — https://www.aihero.dev/posts
[79] ADR-0023: Anthropic Tool Design Best Practices — vishnu2kmohan (repo maintainer) — https://github.com/vishnu2kmohan/mcp-server-langgraph/blob/main/adr/adr-0023-anthropic-tool-design-best-practices.md
[80] Stop Letting LLMs Orchestrate Your AI Agents — Abdelaziz Abdelrasol — https://www.abdelaziznotes.com/posts/stop-letting-llms-orchestrate-your-ai-agents
[81] Memory tool — Claude API documentation — Anthropic — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
[82] Explore the context window — Claude Code Docs — Anthropic — https://code.claude.com/docs/en/context-window
[83] Context Engineering for AI Agents: Lessons from Building Manus — Yichao 'Peak' Ji / Manus — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
[84] AI Engineering: Building Applications with Foundation Models (Chapter 6, Agents) — Chip Huyen / O'Reilly Media — https://www.oreilly.com/library/view/ai-engineering/9781098166298/
[85] Building Applications with AI Agents: Designing and Implementing Multiagent Systems (Ch. 5, Orchestration) — Michael Albada / O'Reilly Media — https://www.oreilly.com/library/view/building-applications-with/9781098176495/
[86] Generative AI Design Patterns: Solutions to Common Challenges When Building GenAI Agents and Applications — Valliappa (Lak) Lakshmanan & Hannes Hapke / O'Reilly Media — https://learning.oreilly.com/library/view/-/9798341622654/
[87] Agentic Architectural Patterns for Building Multi-Agent Systems (Ch. 5, Multi-Agent Coordination Patterns) — Dr. Ali Arsanjani & Juan Pablo Bustos / Packt Publishing — https://www.oreilly.com/library/view/agentic-architectural-patterns/9781806029570/
[88] Why Multi-Agent Systems Need Memory Engineering (O'Reilly Radar) — Richmond Alake (MongoDB) — https://www.oreilly.com/radar/why-multi-agent-systems-need-memory-engineering/
[89] The AI Agents Stack (2026 Edition) — O'Reilly Radar — Paolo Perrone — https://www.oreilly.com/radar/the-ai-agents-stack-2026-edition/

---

## Part IV — Supplemental research: closing the gaps (100+ sources)

*A second round adding 91 new sources (deduped against the first 89), for **180 unique cited sources total** — closing gaps in Google/DeepMind, Microsoft/AutoGen, LangGraph, agent-memory systems, other coding tools, forcing functions, more papers/books, and real-world symptom reports. 14 new key claims survived 3-vote adversarial verification. Citations [90]+ resolve to the "Supplementary sources" list at the end. Headings demoted one level.*

## Supplemental Addendum: Why Orchestrators Under-Delegate

This addendum closes gaps left by the main report and pushes total cited sources past 100 (supplementary numbering starts at [90]). It adds first-party engineering guidance from **Google/DeepMind** and **Microsoft**, the **LangChain/LangGraph** delegation-as-context-isolation framing, the **agent-memory/offloading** literature, cross-tool evidence from **other coding agents** (Cline, opencode, Zed, Amp, Claude Code agent teams), a cluster of 2025–2026 **academic papers** on tool/delegation calibration and verification, recent practitioner **books**, and direct **field reports** of the exact symptom. The net effect is to *reinforce* the main report's core thesis (delegation is fundamentally context isolation; models under-delegate by default) while adding two important complications: (1) delegation and context isolation are separable mechanisms, and (2) for well-specified procedural tasks, self-orchestration can beat delegation.

### New and reinforcing evidence

#### Google / DeepMind
Google's ADK guidance supplies a precise architectural distinction the main report lacked: **delegation and context isolation are two different mechanisms** [90]. A `sub_agent` runs in the *same* session and inherits the parent's full conversation history and state ("Shared" context), whereas the separate **agent-as-a-tool** pattern "runs in its own session," gets "a clean, temporary context" that is "discarded" after returning ("Isolated/None") [90][94]. This is confirmed at code level: `AgentTool.run_async` spins up a fresh session; sub-agents keep the parent session id.

Google also names *why orchestrators end up carrying the work themselves*: LLM-driven sub-agent delegation "completely transfers" control to the child — the root becomes "effectively out of the loop," "a great receptionist but a poor project manager" [91]. To keep an orchestrator in control across a multi-step workflow, Google recommends agent-as-tool, where the root "calls the flight_tool, gets the result, and then calls the hotel_tool" [91] — a pattern that by design pulls every specialist's result back into the orchestrator's own window. So **the control-preserving pattern is also the context-accumulating one.** Google independently names "context rot" from persistent `session.state` in loops and prescribes tool-encapsulation for a "clean, temporary context... discarded, guaranteeing a fresh start" per iteration, and warns "monolithic agents crumble under their own weight because of instruction overload" [94][91] (note: these are vendor design-blog anecdotes, not benchmarked results).

#### Microsoft (Azure, Agent Framework, Magentic-One)
Microsoft's official architecture guidance strongly reinforces the consensus and adds numbers-free but mechanistic precision. The Azure Architecture Center and Well-Architected guides prescribe a complexity ladder (direct model call → single agent with tools, "often the right default" → multiagent), warn "**Don't automatically add agents**... Agent layers add latency, expand the surface area, and complicate testing," and state that in multiagent orchestrations "**context windows can grow rapidly because each agent adds its own reasoning, tool results, and intermediate outputs,**" requiring compaction "to avoid response quality degradation" [97][98]. The Agent Framework names the delegation mechanism explicitly: **agent-as-tools** keeps a primary agent in charge that "might provide only relevant information to the tool agents as needed" (isolation; control returns to primary), whereas **handoff** transfers the whole conversation so the receiver has "full context" (no isolation) [100][139]. Magentic-One / Magentic orchestration [101][102][103][140] is the canonical orchestrator-worker design: a lead Orchestrator maintains a Task Ledger + Progress Ledger, delegates subtasks, and re-plans on stalls.

#### LangChain / LangGraph
LangChain literally names delegation the **"isolate"** strategy of context engineering [112]: a subagent "works in a clean context window," and "the sub-agent's final message is returned as the tool result" so "the main agent receives only the final result, not the dozens of tool calls that produced it" [105][107]. Deep Agents further **auto-offloads any tool input/result over a 20,000-token threshold** to the filesystem (`tool_token_limit_before_evict` default 20000, verified in source) [106][110]. WHEN to delegate: spin up a subagent for **isolated, long-running, parallel, or large-output** subtasks ("context quarantine"), and use LangGraph subgraphs' explicit private-vs-shared state to enforce boundaries, with the orchestrator holding only planning state (`write_todos`) plus final results [107][111]. Harrison Chase reframes the whole problem: "the hard part of building reliable agentic systems is making sure the LLM has the appropriate context at each step" — i.e., delegation is a context-control decision, not parallelism for its own sake [114].

#### Memory systems and context offloading
The offloading literature generalizes "delegation = context isolation" into a broader principle: actively manage what stays in the finite window by branching/compressing/offloading sub-task context, realizable inside one loop *or* via subagents. **Context-Folding** holds the main trajectory to ~8K tokens while processing >100K total (~92% compression) and, after RL training (FoldGRPO), matches or exceeds a ReAct agent needing a 327K window (+20.0% BrowseComp-Plus, +8.8% SWE-Bench Verified) — authors call it "a specific formulation of a general multi-agent system where the main agent delegates sub-tasks to sub-agents" [116] (caveat below). **Sleep-time / background compute** does memory-write and precompute work off the critical path, "reduc[ing] the amount of test-time compute needed to achieve the same accuracy by ~5x" and raising accuracy "by up to 13%" [120]. Letta's **Context Repositories** launch memory subagents that defragment and restructure shared memory in isolated git worktrees that merge back "without blocking your main agent" [123][122]. Foundational framing: MemGPT [115] and CoALA [119].

#### Other coding agents
Independent harnesses converge on the same mechanism. **Cline**: context can "balloon to an alarming size before actual work even begins," so return "curated output back to the main task" [128]. **opencode**: each subagent "handles its own conversation context, preventing cross-task pollution" [130] (feature proposal; the delegation-budget PR is [129]). **Zed**: subagents are "by definition isolated context windows — they are separate sessions" [131][132]. **Amp**: a subagent burns its own tokens while the main thread sees only the summary [134]. **Aider** shows the *single-agent* alternative — a token-budgeted personalized-PageRank repo map (default `--map-tokens` 1k), compression not delegation [133]. **Spring AI** documents the task-subagent pattern [138].

#### Academia
The papers supply mechanisms behind the practitioner consensus. Tool/delegation miscalibration is **bidirectional and scale-dependent** — smaller models under-use tools, larger models over-use them, and answer-only RL worsens over-calling [145][146][148]. A measurable **"knowing–doing gap"**: models internally recognize a tool is needed but fail to act, with 26.5–54.0% mismatch concentrated in the cognition-to-action transition [149]. Over-calling is a **fixable systematic bias** (activation-independent CALL offset), and targeted gating cuts unnecessary calls dramatically (~83% fewer with higher accuracy; ~90% token reduction elsewhere) [150][147][151][152][153]. The **generator-verifier gap** makes "dispatch-then-verify" rational — verifying is cheaper than producing, and verifier-based selection scales more robustly (weak-verifier ensembles close the gap ~14.5% to o3-mini level) [157][158][162]. Context-bloat degradation is empirically grounded: self-directed pruning cut SWE-bench Lite tokens 22.7% at unchanged 60% accuracy [155][156][117][118]. Hierarchical planner-executor separation adds +34% from good plans alone [161]. Supporting surveys: agentic RAG [163], prompt compression [164].

#### Books
Recent practitioner books converge with the consensus: the orchestrator delegates to subagents in "minimal, scoped context windows" (Fajardo [165]) or under "opaque execution" where a subagent's reasoning/memory/tools stay invisible (A2A, Sayfan [169][171]). Curricula treat multi-agent as an **escalation, not a default**: Koenigstein reaches supervisor/hierarchical/swarm only in phase 3 [168]; Infante reserves multi-agent "for complex tasks" while single tool-using agents handle branching workflows [167]. Also: Lanham [166], Taylor [170], O'Brien [172].

### Forcing functions for delegation (deeper)

The reliable forcing function is **architectural, not prompt-only**:

- **Make delegation a tool the orchestrator MUST call.** `tool_choice="required"` guarantees a tool call; frameworks inject a dedicated **handoff tool** so transferring control *requires* a tool call [139][100]. Restrict the orchestrator's toolset so it can only coordinate, and filter handoff mechanics out of downstream context.
- **Router-first / classify-then-dispatch.** Loading every tool schema on every request "collapses to 20% accuracy" at 417 tools; an intent-classifier that narrows the tool namespace before dispatch restores reliability and keeps intermediate output out of the main window [143]. Causal-minimal tool filtering (show only the next-step-relevant tool) and menu-filtering benchmarks corroborate [152][153].
- **Metacognition-triggered gating** (MeCo) and calibration/steering cancel the intrinsic over-call bias at the decision boundary rather than relying on model self-judgment [151][150].
- **Programmatic / strict tool use.** Force schema-*validity* of a call (strict tool use / structured outputs) and force *whether* a call happens (`tool_choice=required`), using programmatic tool calling to keep results out of the window [136][137].
- **Description-as-trigger + explicit naming.** Field reports show the only dependable dispatch is often naming the subagent explicitly (below) [173].

**New counterweight (do NOT over-force format).** Forcing rigid JSON/structured output *around the tool-call decision* can **suppress** tool calling. Moving tool selection to natural language raised tool-call accuracy by **18.4 percentage points** (69.1%→87.5%; +26.1pp on open-weight models) [141], and decoding-level structured constraints can "render tool-call tokens unreachable during generation" (Constraint Tax) [142][144]. Refinement: force call-validity and call-occurrence, but do not impose a rigid output format at the delegation-decision moment.

### Contradictions or tensions with the main report

1. **Delegation ≠ context isolation (Google).** The main report's "delegate = isolate" equivalence is a *partial contradiction* under ADK: `sub_agent` delegation shares the session and does NOT isolate; only tool-wrapping isolates [90][94]. Naive multi-agent structure does not automatically save context.

2. **Naive supervisors are themselves a context-rot vector.** LangGraph's supervisor accumulates the FULL sub-agent message history by default (`output_mode="full_history"`); practitioners report routing accuracy degrading after ~8–12 round trips. The win comes from returning only the last message / running subagents in isolated subgraphs — not from "using a multi-agent framework" [105][111][113].

3. **For procedural tasks, self-orchestration beats delegation.** A 2026 controlled study reports single-model in-context self-orchestration outscoring a LangGraph orchestrator (4.53–5.00 vs 4.17–4.84 on a 5-pt LLM-judge scale) with 1.2–1.7× fewer LLM calls and lower failure rates (e.g., 11.5% vs 24% on travel booking) [104]. **Caveat:** this is a single non-peer-reviewed, fully-synthetic, self-benchmarked preprint whose orchestrated baseline may have been context-starved (per-node prompt only); treat as suggestive, not settled.

4. **"Delegate reads, not writes" is not absolute.** The memory literature shows writes *can* be delegated reliably when committed asynchronously out of the main loop (sleep-time compute, isolated worktrees) [120][123]. What matters is isolating and async-committing the write, not forbidding delegated writes. **Caveat:** the 5×/13% figures measure compute-efficiency/accuracy, not write-reliability, and both sources are Letta's own work.

5. **Delegated verification is fragile exactly where you'd want it.** LLM-as-judge verification is noisy in the long-output/agentic regime and carries position/verbosity/self-enhancement biases, so cheap delegated verification needs careful design, ensembling, or fine-tuning [159][160].

6. **Miscalibration is bidirectional.** "Under-delegation" is only one tail; larger models over-call, and answer-only RL worsens it [145][146][148]. Orchestration reliability is best engineered at the decision boundary, not left to model self-judgment [150][152].

7. **Out-of-distribution scaffolding may explain under-delegation.** Letta argues bespoke primitives push models out-of-distribution vs their post-training, so they're used unreliably; it deprecated MemGPT-style heartbeats and `send_message` to stay "in-distribution" for GPT-5 / Claude 4.5 [124]. **Caveat (contested):** Letta's argument concerns memory/control-loop primitives, not delegation specifically, and the "explains under-delegation" step is an analogical extrapolation from a single vendor blog.

### Field reports of the exact symptom

- **First-party vendor confirmation.** Anthropic's own Claude Code agent-teams docs name the failure mode and prescribe a correction: "Sometimes the lead starts implementing tasks itself instead of waiting for teammates... Wait for your teammates to complete their tasks before proceeding," and separately, tell the lead to wait "if it starts doing work instead of delegating" [127]. (Scoped to the experimental agent-teams feature.)
- **Auto-delegation is unreliable; explicit naming is the only dependable dispatch.** Practitioners report Claude Code routinely handling tasks in the main session even when a subagent's description cleanly matches [173].
- **Under-delegation is often economically rational.** A Task/subagent carries ~20k tokens of fixed overhead even for a trivial one-file check; multi-agent sessions burn ~3–4× up to ~7× the tokens of a single thread, so for small/one-shot work the main thread is ~10× cheaper — the model doing the work itself is frequently the correct tradeoff [177]. Anthropic's own docs concur: agent teams "use significantly more tokens," and "for sequential tasks, same-file edits, or work with many dependencies, a single session... [is] more effective" [127].
- **Delegation is under-adopted in the wild.** Across 2,853 GitHub repos, only 131 configured Subagents vs 2,586 using static context files [179].
- **Mechanism consensus: context rot as the window fills.** Böckeler/Thoughtworks [174], HN "context is the bottleneck" thread [175], and Sourcegraph [178][180] converge on degradation-as-window-fills as why isolation helps; Simon Willison's recommended discipline is delegate reads/exploration, keep judgment/design/review in the main loop [176]. The "Inside the Scaffold" taxonomy finds 11 of 13 agents compose multiple loop primitives rather than relying on multi-agent structure [135].

### Supplementary sources

[90] ADK architecture: When to use sub-agents versus agents as tools — Dharini Chandrashekhar / Google Cloud Blog — https://cloud.google.com/blog/topics/developers-practitioners/where-to-use-sub-agents-versus-agents-as-tools/
[91] Build multi-agentic systems using Google ADK — Ashwini Kumar & Neeraj Agrawal / Google Cloud Blog — https://cloud.google.com/blog/products/ai-machine-learning/build-multi-agentic-systems-using-google-adk
[92] Building Collaborative AI: A Developer's Guide to Multi-Agent Systems with ADK — Annie Wang / Google Cloud Blog — https://cloud.google.com/blog/topics/developers-practitioners/building-collaborative-ai-a-developers-guide-to-multi-agent-systems-with-adk
[93] Building Scalable AI Agents: Design Patterns with Agent Engine on Google Cloud — Schneider Larbi & David Peterside / Google Cloud Blog — https://cloud.google.com/blog/topics/partners/building-scalable-ai-agents-design-patterns-with-agent-engine-on-google-cloud
[94] Technical guide: Four steps for startups to build multi-agent systems — Oluwamayowa Awojuyigbe / Google Cloud Blog — https://cloud.google.com/blog/topics/startups/four-steps-for-startups-to-build-multi-agent-systems
[95] Introducing Gemini Enterprise Agent Platform — Michael Gerstenhaber & Michael Bachman / Google Cloud Blog — https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform
[96] Agent Factory Recap: Build an AI Workforce with Gemini 3 — Smitha Kolan, Vlad Kolesnikov, Brandon Hancock / Google Cloud Blog — https://cloud.google.com/blog/topics/developers-practitioners/agent-factory-recap-build-an-ai-workforce-with-gemini-3
[97] AI agent orchestration patterns (Azure Architecture Center) — Chad Kittel, Clayton Siemens / Microsoft Learn — https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
[98] Application design for AI workloads on Azure (Well-Architected Framework) — Microsoft Azure WAF team / Microsoft Learn — https://learn.microsoft.com/en-us/azure/well-architected/ai/application-design
[99] Orchestrator and subagent multi-agent patterns — Microsoft Copilot/Agents docs team / Microsoft Learn — https://learn.microsoft.com/en-us/agents/architecture/multi-agent-orchestrator-sub-agent
[100] Microsoft Agent Framework — Handoff orchestration (Handoff vs Agent-as-Tools) — Microsoft Agent Framework docs team / Microsoft Learn — https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff
[101] Magentic Agent Orchestration (Semantic Kernel) — Microsoft Semantic Kernel docs team / Microsoft Learn — https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/magentic
[102] Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks (article) — Adam Fourney, Gagan Bansal, Hussein Mozannar, Victor Dibia, Saleema Amershi / Microsoft Research — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
[103] Magentic-One (arXiv paper) — Adam Fourney et al. / arXiv:2411.04468 — https://arxiv.org/abs/2411.04468
[104] In-Context Prompting Obsoletes Agent Orchestration for Procedural Tasks — arXiv preprint — https://arxiv.org/abs/2604.27891
[105] Subagents — LangChain Multi-agent Docs — LangChain / docs.langchain.com — https://docs.langchain.com/oss/python/langchain/multi-agent/subagents
[106] Context engineering in Deep Agents — LangChain / docs.langchain.com — https://docs.langchain.com/oss/python/deepagents/context-engineering
[107] Subagents — Deep Agents Docs (Why use subagents?) — LangChain / docs.langchain.com — https://docs.langchain.com/oss/python/deepagents/subagents
[108] langgraph-supervisor — LangChain / GitHub — https://github.com/langchain-ai/langgraph-supervisor-py
[109] langgraph-swarm — LangChain / GitHub — https://github.com/langchain-ai/langgraph-swarm-py
[110] deepagents — the batteries-included agent harness — LangChain / GitHub — https://github.com/langchain-ai/deepagents
[111] Use subgraphs — LangGraph Docs — LangChain / docs.langchain.com — https://docs.langchain.com/oss/python/langgraph/use-subgraphs
[112] Context Engineering for Agents — Lance Martin / LangChain blog — https://www.langchain.com/blog/context-engineering-for-agents
[113] Multi-Agent Orchestration in LangGraph: Supervisor vs Swarm — Focused.io — https://focused.io/lab/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture
[114] How to think about agent frameworks — Harrison Chase / LangChain blog — https://www.langchain.com/blog/how-to-think-about-agent-frameworks
[115] MemGPT: Towards LLMs as Operating Systems — Charles Packer et al. / arXiv (UC Berkeley) — https://arxiv.org/abs/2310.08560
[116] Scaling Long-Horizon LLM Agent via Context-Folding — arXiv (context-folding.github.io) — https://arxiv.org/abs/2510.11967
[117] ACON: Optimizing Context Compression for Long-horizon LLM Agents — Minki Kang et al. / arXiv — https://arxiv.org/abs/2510.00615
[118] ReSum: Unlocking Long-Horizon Search Intelligence via Context Summarization — arXiv (Alibaba Tongyi Lab) — https://arxiv.org/abs/2509.13313
[119] Cognitive Architectures for Language Agents (CoALA) — Theodore R. Sumers, Shunyu Yao, Karthik Narasimhan, Thomas L. Griffiths / arXiv (Princeton) — https://arxiv.org/abs/2309.02427
[120] Sleep-time Compute: Beyond Inference Scaling at Test-time — Kevin Lin et al. (Letta) / arXiv — https://arxiv.org/abs/2504.13171
[121] Generative Agents: Interactive Simulacra of Human Behavior — Joon Sung Park et al. / arXiv (Stanford) — https://arxiv.org/abs/2304.03442
[122] Memory Blocks: The Key to Agentic Context Management — Letta — https://www.letta.com/blog/memory-blocks/
[123] Introducing Context Repositories: Git-based Memory for Coding Agents — Letta — https://www.letta.com/blog/context-repositories/
[124] Rearchitecting Letta's Agent Loop: Lessons from ReAct, MemGPT, & Claude Code — Letta — https://www.letta.com/blog/letta-v1-agent
[125] Context management in agent harnesses: memory, files, and subagents — Arize AI — https://arize.com/blog/context-management-in-agent-harnesses/
[126] Context Engineering for AI Agents: Part 2 — Philipp Schmid / philschmid.de — https://www.philschmid.de/context-engineering-part-2
[127] Orchestrate teams of Claude Code sessions (Agent teams) — Anthropic / Claude Code documentation — https://code.claude.com/docs/en/agent-teams
[128] Support task/child-task to keep context window of the main task clean and focused (Discussion #4249) — Cline community / GitHub — https://github.com/cline/cline/discussions/4249
[129] feat(task): Add subagent-to-subagent delegation with budgets, persistent sessions, and hierarchical session navigation (PR #7756) — opencode contributor / GitHub — https://github.com/anomalyco/opencode/pull/7756
[130] [feat] Add "subagent" AI task delegation (Issue #1293) — opencode community / GitHub — https://github.com/anomalyco/opencode/issues/1293
[131] Subagents for Zed Agent Mode (Discussion #32620) — Zed community; Joseph T. Lyons / GitHub — https://github.com/zed-industries/zed/discussions/32620
[132] Agent Panel: render nested subagents as collapsible sub-threads (Discussion #57481) — Zed community / GitHub — https://github.com/zed-industries/zed/discussions/57481
[133] Repository map | Aider — Paul Gauthier / Aider — https://aider.chat/docs/repomap.html
[134] Amp Owner's Manual — Sourcegraph (Amp team; Thorsten Ball et al.) — https://ampcode.com/manual
[135] Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures — arXiv:2604.03515 — https://arxiv.org/abs/2604.03515
[136] Programmatic tool calling — Anthropic / Claude Platform Docs — https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
[137] Structured outputs (strict tool use) — Anthropic / Claude Platform Docs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[138] Spring AI Agentic Patterns (Part 4): Subagent Orchestration — Christian Tzolov / Spring blog — https://spring.io/blog/2026/01/27/spring-ai-agentic-patterns-4-task-subagents/
[139] Microsoft Agent Framework — Handoff orchestration — Microsoft / Microsoft Learn — https://learn.microsoft.com/agent-framework/workflows/orchestrations/handoff
[140] Microsoft Agent Framework — Magentic orchestration — Microsoft / Microsoft Learn — https://learn.microsoft.com/agent-framework/workflows/orchestrations/magentic
[141] Natural Language Tools: A Natural Language Approach to Tool Calling In Large Language Agents — arXiv preprint — https://arxiv.org/abs/2510.14453
[142] Constraint Tax in Open-Weight LLMs: Tool Calling Suppression Under Structured Output Constraints — arXiv preprint — https://arxiv.org/abs/2606.25605
[143] The Intent Classification Layer Most Agent Routers Skip — Tian Pan / TianPan.co — https://tianpan.co/blog/2026-04-16-intent-classification-agent-routers
[144] Tool Calling — vLLM Documentation — vLLM project docs — https://docs.vllm.ai/en/stable/features/tool_calling/
[145] The Tool-Overuse Illusion: Why Does LLM Prefer External Tools over Internal Knowledge? — arXiv preprint — https://arxiv.org/abs/2604.19749
[146] OTC: Optimal Tool Calls via Reinforcement Learning — arXiv preprint — https://arxiv.org/abs/2504.14870
[147] SMART: Self-Aware Agent for Tool Overuse Mitigation — arXiv preprint — https://arxiv.org/abs/2502.11435
[148] To Call or Not to Call: A Framework to Assess and Optimize LLM Tool Calling — Max Planck Institute for Software Systems et al. / arXiv — https://arxiv.org/abs/2605.00737
[149] Model-Adaptive Tool Necessity Reveals the Knowing-Doing Gap in LLM Tool Use — Yize Cheng et al. / arXiv — https://arxiv.org/abs/2605.14038
[150] To Call or Not to Call: Diagnosing Intrinsic Over-Calling Bias in LLM Agents — SJTU & Shanghai AI Laboratory et al. / arXiv — https://arxiv.org/abs/2605.18882
[151] Adaptive Tool Use in Large Language Models with Meta-Cognition Trigger (MeCo) — ACL 2025 / arXiv — https://arxiv.org/abs/2502.12961
[152] ToolChoiceConfusion: Causal Minimal Tool Filtering for Reliable LLM Agents — arXiv preprint — https://arxiv.org/abs/2606.06284
[153] ToolMenuBench: Benchmarking Tool-Menu Filtering Strategies for Reliable and Efficient LLM Agents — arXiv preprint — https://arxiv.org/abs/2606.15508
[154] SENTINEL: Failure-Driven Reinforcement Learning for Training Tool-Using Language Model Agents — arXiv preprint — https://arxiv.org/abs/2606.12908
[155] Active Context Compression: Autonomous Memory Management in LLM Agents (Focus) — arXiv — https://arxiv.org/abs/2601.07190
[156] A Survey of Context Engineering for Large Language Models — Lingrui Mei et al. / arXiv — https://arxiv.org/abs/2507.13334
[157] Shrinking the Generation-Verification Gap with Weak Verifiers (Weaver) — Jon Saad-Falcon et al. / Stanford Scaling Intelligence Lab — https://arxiv.org/abs/2506.18203
[158] Trust but Verify! A Survey on Verification Design for Test-time Scaling — arXiv:2508.16665 — https://arxiv.org/abs/2508.16665
[159] Can LLM-as-a-Judge Reliably Verify Rubrics in Agentic Scenarios? (RuVerBench) — arXiv:2606.29920 — https://arxiv.org/abs/2606.29920
[160] A Survey on LLM-as-a-Judge — Jiawei Gu, Xuhui Jiang et al. / arXiv — https://arxiv.org/abs/2411.15594
[161] Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks — Lutfi Eren Erdogan et al. (UC Berkeley) / arXiv (ICML 2025) — https://arxiv.org/abs/2503.09572
[162] Scaling Test-time Compute for LLM Agents — King Zhu, Hanhao Li et al. / arXiv — https://arxiv.org/abs/2506.12928
[163] Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG — Aditi Singh, Abul Ehtesham, Saket Kumar, Tala Talaei Khoei / arXiv — https://arxiv.org/abs/2501.09136
[164] Prompt Compression for Large Language Models: A Survey — Zongqian Li, Yinhong Liu, Yixuan Su, Nigel Collier (Cambridge) / arXiv — https://arxiv.org/abs/2410.12388
[165] Build a Multi-Agent System (from Scratch) — Val Andrei Fajardo / Manning (MEAP) — https://www.manning.com/books/build-a-multi-agent-system-from-scratch
[166] AI Agents in Action, Second Edition — Micheal Lanham / Manning — https://www.manning.com/books/ai-agents-in-action-second-edition
[167] AI Agents and Applications: With LangChain, LangGraph, and MCP — Roberto Infante / Manning — https://www.manning.com/books/ai-agents-and-applications
[168] AI Agents: The Definitive Guide — Nicole Koenigstein / O'Reilly Media — https://www.oreilly.com/library/view/ai-agents-the/0642572247775/
[169] Design Multi-Agent AI Systems Using MCP and A2A — Gigi Sayfan / Packt — https://www.oreilly.com/library/view/design-multi-agent-ai/9781806116478/
[170] Context Engineering with DSPy — Mike Taylor / O'Reilly Media — https://www.oreilly.com/library/view/context-engineering-with/0642572261603/
[171] Designing Collaborative Multi-Agent Systems with the A2A Protocol — Gigi Sayfan / O'Reilly Radar — https://www.oreilly.com/radar/designing-collaborative-multi-agent-systems-with-the-a2a-protocol/
[172] Building Complex Multi-Agent Systems Using Pattern Prompting — Tim O'Brien / Packt — https://www.amazon.com/Building-Complex-Multi-Agent-Systems-Prompting/dp/1806114291
[173] Claude Sub Agents and Agent Teams: When to Delegate Inside Claude — HatchWorks — https://hatchworks.com/blog/claude/claude-sub-agents-and-agent-teams/
[174] Context Engineering for Coding Agents — Birgitta Böckeler (Thoughtworks) / martinfowler.com — https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html
[175] Context is the bottleneck for coding agents now (HN discussion) — Hacker News — https://news.ycombinator.com/item?id=45387374
[176] Agentic Engineering Patterns — Simon Willison / Simon Willison's Newsletter — https://simonw.substack.com/p/agentic-engineering-patterns
[177] Claude Code — When to use the Task tool vs subagents — Amit Kothari / amitkoth.com — https://amitkoth.com/claude-code-task-tool-vs-subagents/
[178] Agentic Coding in 2026: A Practical Guide for Big Code — Sourcegraph — https://sourcegraph.com/blog/agentic-coding
[179] Configuring Agentic AI Coding Tools: An Exploratory Study — Matthias Galster et al. / arXiv — https://arxiv.org/abs/2602.14690
[180] What Hacker News Gets Right About AI Coding Agents in 2026 — Developers Digest — https://www.developersdigest.tech/blog/what-hacker-news-gets-right-about-ai-coding-agents-2026
