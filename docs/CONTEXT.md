<!--
  devmate glossary ledger (E8-2).

  Schema: the frontmatter fence below holds a JSON object with:
    - schemaVersion: number (currently 1)
    - entries: GlossaryEntry[] where each entry is:
        { term, definition, sourceFiles: string[], updatedAt: ISO date,
          staleReason?: string (present only when the entry is stale) }

  Entries are pointers to where a concept lives in the repo (TCM-3), not pasted
  definitions. Never inject this whole file into agent context — always retrieve
  selectively via queryGlossary() in lib/memory/glossary.mjs.

  This file is read/written by lib/memory/context-ledger.mjs
  (loadGlossary / saveGlossary). Edit via that module, or keep the JSON valid.
-->

---
{
  "schemaVersion": 1,
  "entries": [
    {
      "term": "TaskState",
      "definition": "The canonical per-task state object threaded through the devmate workflow.",
      "sourceFiles": ["lib/types.mjs"],
      "updatedAt": "2026-06-24"
    }
  ]
}
---

## Glossary (human-readable view)

| Term | Definition | Source files | Status |
| --- | --- | --- | --- |
| TaskState | The canonical per-task state object threaded through the devmate workflow. | `lib/types.mjs` | fresh |
