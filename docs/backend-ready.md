# Backend readiness (E5-4)

devmate gates Tier 5 E2E tests on backend readiness. The check is **stack-agnostic** —
there is no hardcoded Spring/actuator assumption (E10).

## Where predicates come from

`loadHealthPredicates()` resolves in this order:

1. An explicit predicate file passed via `--config <path>` (JSON array).
2. The `healthPredicates` key in `devmate.config.json` (primary source).
3. A `.devmate/health-predicates.json` fallback file.
4. **Nothing configured → empty list → backend treated as ready/skip.**

A frontend-only consumer with no backend is never blocked by a phantom probe.

## Predicate shape

```json
{
  "healthPredicates": [
    { "url": "http://localhost:8080/health", "statusCode": 200, "bodyContains": "ok", "timeoutMs": 5000 }
  ]
}
```

- `url` (required) — HTTP URL to probe.
- `statusCode` — expected status (default `200`).
- `bodyContains` — substring that must appear in the response body.
- `timeoutMs` — per-request timeout (default `5000`).

Non-Spring backends are supported via `statusCode` + `bodyContains`. The old
`localhost:8080/actuator/health` + `"status":"UP"` is just one possible config, not a default.

## Hardening

- `assertBackendReadyBeforeTier5(state, predicates)` re-runs the check immediately
  before Tier 5. A stale gate (`backendReadyStaleSince` set) throws without probing.
- On failure, the gate is marked stale (`markBackendReadyStale`) and an `e2e_blocked`
  trace event is appended **before** the E2E subprocess launches (no trace race).

## CLI

```
node scripts/check-backend-ready.mjs [--config <file>] [--mark-stale-on-failure]
```

Exit `0` when ready (including no-backend skip), `1` when not.
