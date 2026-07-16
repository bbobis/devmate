# Code Generation Rules

> When writing or generating any code, apply all rules below.
> Also apply Pragmatic Programmer generation rules: [skills/pragmatic-programmer/refs/code-generation.md](../../pragmatic-programmer/refs/code-generation.md)

## Design Principles to Apply

### Simplicity 🟢 MINDSET
- KISS: write the simplest solution that is correct
- YAGNI: build only what is required now, not what *might* be needed
- DRY: one authoritative place per piece of **domain knowledge** (not just text that looks similar)
- Rule of Three: tolerate similar-looking code until you've seen the pattern evolve twice

### Module Design 🟡 SOFT
- Prefer deep modules: simple interfaces, complex implementation hidden inside
- A function earns its existence if it: names a non-obvious concept, hides real complexity, removes knowledge duplication, or makes testing easier
- SRP: one reason to change; group things that change together, split things that change independently
- SoC: business logic, data access, and API handling in their own layers
- CQS: a function either does something (command) OR returns something (query) — not both

### SOLID Quick Rules
- 🔴 HARD: LSP — subtypes must honour the base contract; never throw where the base promises it works
- 🔴 HARD: DIP — depend on abstractions, inject implementations; never `new MySQLDatabase()` inside a service
- 🟡 SOFT: OCP — add new behavior via new modules, not by editing existing ones
- 🟡 SOFT: ISP — small focused interfaces over one fat one

### Immutability 🟡 SOFT
- Prefer immutable data structures
- On mutation, return a new object: `return { ...cart, total: cart.total * 0.9 }`
- 🔴 HARD: Never pass shared mutable objects between services

### Fail Fast 🔴 HARD
- Validate inputs at every trust boundary (constructors, API entry, service inputs)
- Throw immediately if a precondition fails — before any state is modified
- Layer validation: API→400, Service→domain exception, Repository→wrap+rethrow

### Error Handling 🔴 HARD
- Never swallow exceptions silently
- Catch specific errors — never `catch (Exception e)` everything
- Do not use exceptions as flow control for expected outcomes
- Always preserve the error chain: `throw new ConfigError("msg", { cause: error })`

### Naming 🟡 SOFT
- Full words, not abbreviations: `calculateAmount` not `calcAmt`
- Booleans with `is`/`has` prefix: `isActive`, `hasSubscription`
- Functions start with a verb: `createUser`, `fetchOrders`, `validateInput`
- No generic names: avoid `data`, `value`, `temp`, `item`
- No double negatives: prefer `isAuthenticated` over `isNotAuthenticated`
- UPPER_CASE for constants: `MAX_RETRY_LIMIT`

### Observability 🟡 SOFT
- Use structured logging (JSON) — not plain string messages
- Attach correlation/trace IDs to every request log
- Log levels: ERROR = human action required; INFO = notable event; DEBUG = developer detail
- Never log passwords, tokens, or PII

### AI-Specific Rules 🟡 SOFT
- Check existing patterns before generating — the codebase may already have the abstraction
- Prefer small diffs — large AI-generated changes are harder to review
- Generated code must have tests — unverified behavior is untested behavior
- Explain integration points — what existing modules does the new code touch?
- Never bypass architecture: no SQL in controllers, no skipping repository layers
- Ask: "Would this be removed if the class didn't exist?" — if yes, it is a shallow module
