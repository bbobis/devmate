# Architecture: Complexity, Modules, Coupling & Cohesion

> Cross-reference: also apply Pragmatic Programmer architecture rules from [skills/pragmatic-programmer/refs/architecture.md](../../pragmatic-programmer/refs/architecture.md)

## North Star 🟢 MINDSET

Design against complexity continuously. Complexity = change amplification + cognitive load + unknown unknowns.
Strategic programming: invest 10–20% extra time in design every sprint. Never let debt compound.

## Deep vs Shallow Modules 🟡 SOFT

- A **deep module** = simple narrow interface that hides significant complexity inside
- A **shallow module** = complex interface relative to what it does (adds surface, hides nothing)
- Depth test: "If I remove this class, does the system become simpler or more complex?"
  - More complex → deep module, keep it
  - Simpler → shallow module, merge or remove it
- Anti-patterns: **Function Confetti** (tiny pass-throughs), **Classitis** (micro-classes that hide nothing)

## Information Hiding 🟢 MINDSET

- Every module should have a **secret** — an implementation detail likely to change
- Interface exposes only stable aspects; internals stay hidden
- What to hide: DB schema, algorithms, resource management, framework details, error conditions resolvable internally
- 🔴 HARD anti-pattern: leaking internal DB column names through the public API

## Coupling & Cohesion 🟢 MINDSET

- **Low coupling**: modules communicate through stable interfaces; no reaching into each other's internals
- **High cohesion**: a module does one well-defined thing; not a grab bag
- Rule of thumb: low coupling + high cohesion = well-structured system

## Domain Invariants 🔴 HARD

- Business rules must live **near the data they protect**, not scattered across services
- Every business rule enforced in a single domain object, never duplicated across API, service, UI, batch jobs

## Law of Demeter 🟡 SOFT

- Talk to immediate neighbors only, not the neighbors of neighbors
- ❌ `order.getCustomer().getAddress().getCity()`
- ✅ `order.shippingCity()`

## DDD Alignment 🟡 SOFT

- **Ubiquitous language**: code uses the same terms the business uses (`Invoice`, `LineItem`, not `TblUsrRec`)
- **Bounded contexts**: same word can mean different things in different contexts; each context owns its model
- **Aggregates**: cluster of domain objects that change together; external code touches only the aggregate root

## Composition Over Inheritance 🟡 SOFT

- Favor injecting behavior over deep class hierarchies
- Deep hierarchies = fragile base class problem
- ✅ `class ElectricCar { constructor(engine: ElectricEngine, battery: BatteryModule) {} }`
