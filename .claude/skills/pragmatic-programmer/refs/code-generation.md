# Pragmatic Programmer — Code Generation Rules

> Load when: writing new code, implementing a feature, generating any function/class/module.

## ETC (Tip 14)
- Before generating any code, ask: *"If requirements change for this piece, how many other files must change?"*
- Strive for the answer to be **one**.
- A React component mixing data fetching, business logic, and rendering violates ETC. Separate them.
- A service tightly coupled to a specific DB vendor violates ETC. Hide the vendor behind an interface.

## DRY — Don't Repeat Yourself (Tips 15, 16)
- Never duplicate logic — extract shared utilities instead of copy-pasting.
- Never duplicate knowledge in comments — a comment that restates what code says clearly is a DRY violation.
- Never duplicate schema — don't write POJOs that mirror a DB schema when JPA/codegen can do it.
- Never duplicate API contracts — two classes both knowing the shape of an external API response is a DRY violation.
- If reusing code is harder than writing it, make reuse easier (Tip 16).

## Orthogonality (Tip 17)
- Write **shy code** — modules that don't reveal unnecessary internals and don't depend on other modules' implementations.
- Pass context explicitly via constructors or method parameters; avoid global data.
- Test: *"If I change requirements for X, how many modules must change?"* The answer must be **one**.
- Never use inheritance for code reuse. Prefer **interfaces, delegation, composition** (Tips 52–54).

## Reversibility (Tips 18, 19)
- Hide third-party APIs behind your own abstraction layers (e.g. `UserRepository` interface, not scattered JPA calls).
- Evaluate new technologies with prototypes, not enthusiasm. Don't adopt frameworks because they're trending.

## Tracer Bullets (Tip 20)
- For every new feature, build a **thin but complete end-to-end vertical slice first** — all layers wired, even as stubs.
- A tracer bullet is NOT a prototype. It is production-quality and kept.
- Checklist:
  1. UI component renders (even stubbed)
  2. API endpoint exists and responds
  3. Business logic layer exists (even stub)
  4. DB schema/persistence exists
  5. Full vertical slice is wired and callable end-to-end

## Naming (Tip 74)
- Names must reveal intent, not hide it.
- Use **domain vocabulary** — if domain experts say "buyer", code must say `buyer`, not `user`.
- Honor language conventions: `camelCase` in Java/TypeScript, `snake_case` in Python/SQL.
- When a name no longer fits, **rename immediately**. Deferred renaming compounds into confusion.
- Misleading names are worse than meaningless names.

## Transforming Data (Tip 50)
- Think in **pipelines**: `input → transform → transform → output`.
- Do not mutate shared state. Pass data through chains of pure transformations.

## Configuration (Tip 55)
- **Never hardcode** environment-specific values: DB URLs, API keys, feature flags, service endpoints, ports.
- All environment-specific values must come from external config (env vars, config files, config server).
