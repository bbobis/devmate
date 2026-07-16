# Pragmatic Programmer — Testing Guidance

> Load when: writing tests, debugging, setting up CI, or deciding test strategy.
> Source: Tips 66–70.

## Core Principle
Hard-to-test code is a **design smell** — it signals a coupling or responsibility problem, not a testing problem.
Code written test-first tends to be more modular, more focused, and less coupled.

## Test Pyramid

| Layer | Tool | When |
|-------|------|------|
| Unit tests | Jest / JUnit | Business logic and utilities — always |
| Integration tests | TestContainers | Repository/DB layer |
| Contract tests | WireMock | API boundaries |
| E2E tests | Playwright / Cypress | Sparingly — slow and brittle |

## Hard Rules
- **Test Early, Test Often, Test Automatically (Tip 66):** Tests run on every commit. Failing tests block merges.
- **Find Bugs Once (Tip 67):** When a bug is found manually, write an automated test for it **before fixing it**. The test must fail first, then pass.
- **Property-Based Tests (Tip 68):** For functions with broad input domains, verify invariants across many random inputs — not just example-based tests.
- **Test Your Software, or Your Users Will (Tip 70).**

## Refactoring Safely (Tip 65)
1. Ensure tests exist before touching code
2. Make small, verifiable steps
3. Run tests after **each** step — never refactor without a safety net

## Failure modes to flag
- Tests written after the fix (not before)
- Tests that pass trivially before implementation exists
- No integration test for the DB/repository layer
- E2E tests covering what unit tests should cover
- Skipped or commented-out tests left in the codebase
