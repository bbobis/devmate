# Pragmatic Programmer — Architecture Guidance

> Load when: making structural decisions, designing new modules, reviewing coupling or dependencies.

## Decoupling (Tips 44–48)
- Avoid global data (Tip 47). Every piece of global state is an invisible coupling between all code that touches it.
- If something is important enough to be global, wrap it in an API (Tip 48). DB connections, caches, config — always through a controlled interface.
- Symptoms of over-coupling to flag: a simple change propagates through many unrelated files; developers afraid to change code.

## Event Strategies (Tip 49)

| Strategy | Use When |
|----------|----------|
| Finite State Machine | Workflow states, multi-step processes, protocol parsing |
| Observer Pattern | Simple in-process notification; watch for tight coupling |
| Pub/Sub (Kafka, RabbitMQ) | Decoupled async messaging; producer/consumer must not know each other |
| Reactive Streams | Real-time data pipelines; composing and transforming event streams |

## Inheritance Tax (Tips 52–54)
- **Do not use subclassing for code reuse.** Inheritance creates tight coupling and brittle hierarchies.
- Always prefer: **Interfaces** (behavior contracts without implementation coupling), **Delegation** (has-a over is-a), **Mixins/Traits** (behavior without hierarchy).

## Temporal Coupling (Tip 56)
- Map out actual data dependencies before enforcing ordering.
- Only sequence operations where a **true data dependency** exists.
- Unnecessary sequential steps limit throughput and testability.

## Concurrency and Shared State (Tips 57–59)
- Shared mutable state is a fundamental source of bugs. Minimize it.
- Each component should own its own state; communicate via messages or events, not shared memory.
- In React: lift state up or use a controlled store (Redux, Zustand, Context).

## Resource Management (Tips 40, 41)
- The routine that allocates a resource is responsible for deallocating it.
- Use `try-with-resources` in Java for connections, streams, and files.
- Always account for exceptions mid-operation — resources must be released on failure.

## Vocabulary Quick Reference

| Term | Definition |
|------|------------|
| **ETC** | Easier To Change — the single measure of good design |
| **DRY** | Don't Repeat Yourself — every piece of knowledge has one authoritative representation |
| **Orthogonality** | Two components are orthogonal if changes to one don't affect the other |
| **Tracer Bullet** | A thin, complete, production-quality end-to-end feature — not a prototype |
| **Broken Window** | Any bad design, wrong decision, or poor code left unrepaired |
| **Train Wreck** | A chain of method calls traversing too many layers of abstraction |
| **Tell, Don't Ask** | Tell objects to do things; don't query their state to make decisions outside them |
| **Temporal Coupling** | A constraint that A must happen before B, limiting concurrency |
| **Shy Code** | Code that doesn't reveal unnecessary internals and doesn't depend on others' implementations |
| **Technical Debt** | Accumulated broken windows — it compounds; it rarely gets paid back |
| **Design by Contract** | Every function defines preconditions, postconditions, and invariants |
