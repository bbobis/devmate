# Application Security — Secure Coding

> Load when: writing, editing, or reviewing code.

## Hard Rules (OWASP Top 10)

- **Injection (A03)** — Never concatenate user input into SQL, shell, LDAP, or XML queries. Always use parameterized queries or prepared statements.
- **Broken Authentication (A07)** — Never roll custom auth. Use vetted libraries and standard protocols. Enforce MFA for privileged operations.
- **Sensitive Data Exposure (A02)** — Never store passwords in plain text. Use bcrypt / argon2 with appropriate cost factors. Never log PII, tokens, or passwords.
- **Access Control (A01)** — Enforce authorization checks server-side on every request. Never trust client-supplied role or ID claims without re-validation.
- **Security Misconfiguration (A05)** — Default config must be the most secure option. Remove debug endpoints, default credentials, and verbose error messages before any deployment.
- **Hardcoded Secrets** — Never commit credentials, API keys, tokens, or passwords to source control. Use environment variables or a secrets manager.
- **Input Validation** — Validate and sanitize every external input at the API boundary before any processing. Trust no external data source.
- **Error Handling** — Never expose stack traces, internal paths, or DB error messages to the client. Log them server-side only.
- **Dependencies (A06)** — Treat every unpatched dependency as a known vulnerability. Patch Critical/High findings within your org's SLA.

## Java / Spring Boot specifics

- Use `@NotNull`, `@Min`, `@Size`, `@Pattern` at all API boundaries.
- Use `Optional<T>` — never return `null` from a public API.
- Use Spring Security with OAuth2 / OIDC — do not parse JWTs manually.
- Use JPA named queries or `@Query` with bind parameters — never `createNativeQuery` with string concat.
- Never expose actuator endpoints without authentication in production.

## TypeScript / React specifics

- Sanitize all HTML output — never use `dangerouslySetInnerHTML` with unsanitized user input.
- Store auth tokens in `httpOnly` cookies, not `localStorage`.
- Validate all API responses against a typed schema before using them in state.
- Never embed secrets or API keys in the frontend bundle.

## Pre-Output Checklist

The agent MUST pass all checks before emitting any code change:

- [ ] Is all user/external input validated and sanitized before use? (Injection, A03)
- [ ] Are all DB queries parameterized — no string concatenation? (SQLi, A03)
- [ ] Are authorization checks enforced server-side on every path? (A01)
- [ ] Are secrets and credentials absent from source code and logs? (Hardcoded secrets)
- [ ] Is PII, password, or token data never logged in plain text? (A02)
- [ ] Are error messages safe for client consumption — no stack traces? (A05)
- [ ] Are all dependencies at latest patched versions for this change? (A06)
- [ ] Does this code use standard auth libraries — not custom JWT/session logic? (A07)
- [ ] Is the default configuration the most secure option? (A05)
- [ ] Are there security-focused tests for injection, auth bypass, and access control?
