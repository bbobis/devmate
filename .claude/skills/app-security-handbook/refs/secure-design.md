# Application Security — Secure Design

> Load when: making architecture decisions, choosing tech stack, designing data flow, or reviewing system diagrams.

## Hard Rules

- **Shift left by default.** The cost of a security fix grows at every SDLC stage. Fix design flaws at design time, not in production.
- **Pick standard security controls before custom ones:**
  - Auth: OAuth 2.0 / OIDC over custom JWT handling.
  - AuthZ: RBAC or ABAC patterns over scattered `if (isAdmin)` guards.
  - Encryption: vetted libraries (AES-256-GCM, TLS 1.2+) over custom schemes.
  - Session: short-lived tokens with rotation over long-lived static secrets.
- **Data classification drives design decisions:**
  - Public data — standard TLS in transit.
  - Internal / sensitive — TLS in transit + encryption at rest.
  - Regulated (PII, PCI, PHI) — field-level encryption + key lifecycle management + access audit log.
- **Impersonation and delegation features are high-risk by default.** Always require:
  - Short-lived, scoped impersonation tokens.
  - Explicit audit log for every impersonation session.
  - Visible UI indicator that the session is impersonated.
  - Role-based gate controlling who can impersonate whom.
- **Design for least privilege at every layer:**
  - DB users have only the permissions their queries require.
  - Service accounts are scoped to their integration, not org-wide.
  - API keys carry only the scopes needed for their caller.
- **Third-party and open-source components are attack surface.** Require:
  - SCA scan before adoption.
  - Pin versions and define an upgrade cadence.
  - Track CVEs for every production dependency.

## Architecture review checklist

- [ ] Is data classification defined for every entity and flow?
- [ ] Is authentication and authorization using a standard protocol?
- [ ] Are encryption requirements documented (at rest, in transit, field-level)?
- [ ] Is least privilege enforced at every layer (DB, service, API)?
- [ ] Are impersonation or delegation flows explicitly scoped and audited?
- [ ] Are all third-party dependencies SCA-scanned and version-pinned?
- [ ] Does the design account for brute-force, replay, and token-theft scenarios?
