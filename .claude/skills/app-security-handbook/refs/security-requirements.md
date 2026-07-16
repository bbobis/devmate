# Application Security — Security Requirements

> Load when: reviewing a user story, use case, new feature, or requirement ticket.

## Hard Rules

- **Derive security requirements alongside functional requirements.** For every feature, identify:
  - Who can use it (authentication + authorization scope).
  - What data it touches and its classification (public / internal / sensitive / regulated).
  - What must be logged (audit trail: who, what, when).
  - What must be encrypted (at rest, in transit, field-level where required).
- **Security requirements must be co-authored by AppSec** — not defined by the product owner or dev team alone.
- **Use both functional and non-functional forms:**
  - Functional example: *"System shall provide the ability to create a usage report."*
  - Non-functional (security): *"Report creation shall be available only to authenticated administrators of the requesting org."*
- **Never use a homemade auth/authz solution** when a standard protocol (OAuth 2.0 / OIDC / RBAC) exists and fits.
- Security requirements from threat models and risk assessments must feed back into the backlog before development starts.

## Questions to ask for every feature

1. What data is exposed or modified? What is its classification?
2. Who should be able to trigger this — and who should be explicitly blocked?
3. If abused, what is the worst-case business or data impact?
4. Are there audit or compliance requirements (GDPR, HIPAA, PCI-DSS, SOC 2) that apply?
5. Is there a similar pattern elsewhere in the codebase that already has a secure implementation?

## Failure modes to flag immediately

- Feature spec with no mention of who can access it.
- PII or financial data touched with no encryption or masking requirement.
- Feature that impersonates or acts on behalf of another user with no audit, token scope, or expiry requirement.
- External integration with no input validation or schema contract.
