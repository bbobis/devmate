# External code-graph MCP servers — evaluated, not bundled (2026-07-10)

**What this records:** the evaluation behind the decision that devmate will
**never bundle** a code-graph MCP server, the verified verdicts on the two
servers the original "Domain-Aware Code Navigation" proposal (2026-07-10)
recommended, and how a consumer can wire one into their **own** repo without
devmate's involvement. Every factual claim below carries a source URL and an
as-of date; recommendations are labeled as recommendations. Findings were
adversarially verified on 2026-07-10 (3-vote verification per claim).

---

## Why devmate does not bundle one (decision, not a gap)

1. **Zero-runtime-dependency rule.** devmate ships no runtime dependencies by
   design ([CONTRIBUTING.md](../../CONTRIBUTING.md)); a code-graph server is a
   heavyweight runtime dependency with its own indexing lifecycle.
2. **Graceful-degradation posture.** The one MCP server devmate does ship —
   the memory server (mcp/memory-server.mjs, wired via .mcp.json) — is
   zero-dependency and dual-runtime: hosts without MCP support lose only that
   tool surface. A bundled graph server could not degrade that cleanly.
3. **The USER_GUIDE promise.** The guide commits to "no separate install" and
   "no MCP server to set up" ([USER_GUIDE](../USER_GUIDE.md), Section 6);
   bundling an external graph server would break that promise.

devmate's own navigation stack stays path/glob-anchored and deterministic:
the discovery scan + merge (FO epic), discovery agents, and the business-domain
map with per-domain context injection and skill re-rank (DN epic). Symbol-level
navigation is deliberately out of scope until a mature external option exists —
consumers who need it now can wire one themselves (below).

---

## Evaluated servers

### codebase-memory-mcp — VERIFIED; the mature option for multi-language repos

- **Source:** https://github.com/DeusData/codebase-memory-mcp (README claims
  verified by direct fetch, as of 2026-07-10).
- Tree-sitter-based multi-language indexer — the README documents **158
  vendored tree-sitter grammars**.
- SQLite storage (per-user cache under ~/.cache/codebase-memory-mcp/, WAL
  mode); ships as a **single static binary** for macOS/Linux/Windows.
- Adoption and rigor signals (as of 2026-07-10): ~29.5k GitHub stars, active
  releases, 5,604 tests, SLSA 3 supply-chain attestation.
- Design described in the preprint at https://arxiv.org/abs/2603.27277
  (cited by the README).
- **Recommendation:** the option to evaluate first for multi-language repos.

### @ttsc/graph — VERIFIED to exist; recommend re-evaluate later, not adopt

- **Sources:** https://www.npmjs.com/package/@ttsc/graph (registry metadata +
  tarball inspection) and https://github.com/samchon/ttsc, as of 2026-07-10.
- Uses the native TypeScript 7 compiler with exact tsconfig-alias/monorepo
  resolution — TypeScript-only by construction.
- **Very new:** first release 2026-06-23; ~243 GitHub stars as of 2026-07-10.
- Its MCP surface is a **single tool** — inspect_typescript_graph, exposing
  seven operations.
- **Re-evaluation criteria** (all three before reconsidering): package age
  over 6 months; a real adoption signal (ecosystem usage, not stars alone);
  API stability across releases.

### ⚠️ The fabricated tool names — do not re-import this error

The original proposal cited four @ttsc/graph MCP tools: resolveSymbol,
findReferences, getDependencyTree, and getCallGraph. **None of these exist in
the package** (verified by tarball inspection, 2026-07-10). The package's
only MCP tool is inspect_typescript_graph. Any future issue or design doc
citing those four names is propagating a hallucination — check the package
surface directly before citing it.

---

## Wiring one yourself (consumer-side, optional)

This is ordinary MCP host configuration in **your** repo — devmate is not
involved, requires nothing, and keeps working identically with or without it:

1. Install/obtain the server per its own docs (binary or npm package).
2. Register it in your repo's MCP configuration for your host, with the
   command and args the server's README specifies. For VS Code that is the
   workspace file `.vscode/mcp.json`
   (https://code.visualstudio.com/docs/copilot/chat/mcp-servers, verified
   2026-07-12); for Claude Code it is a repo-root `.mcp.json` (the same
   mechanism devmate's own memory server uses in this repo).
3. Approve the server in your host when prompted, and scope it to the repos
   that need it.

Keep the same honesty discipline devmate applies to its own docs: verify the
tool names the server actually exposes before writing procedures against
them (see the fabricated-names warning above).

---

## Sources (as of 2026-07-10)

- https://github.com/DeusData/codebase-memory-mcp — README claims verified by
  direct fetch.
- https://www.npmjs.com/package/@ttsc/graph + https://github.com/samchon/ttsc
  — registry metadata + tarball inspection.
- https://arxiv.org/abs/2603.27277 — cited by the codebase-memory-mcp README.
- https://code.visualstudio.com/docs/copilot/chat/mcp-servers — VS Code
  workspace MCP configuration file location (verified 2026-07-12).

> [UNVERIFIED] items (excluded from the recommendation): the content of
> https://ttsc.dev/docs/graph (site unreachable through the verification
> proxy; the URL is confirmed only as the README's documentation link).
