# Application Security — Security Debt & Prioritization

> Load when: managing a vulnerability backlog, triaging findings across sprints, or communicating risk to stakeholders.

## Core principle

Security debt = unfixed vulnerabilities that accumulate over time, identical to technical debt.
Every new release that ships without fixing known issues adds to the debt.
Debt left long enough will eventually be exploited.

## Prioritization framework

Score each open finding on three axes:

| Axis | Weight | Criteria |
|---|---|---|
| Severity | High | Critical = 4, High = 3, Medium = 2, Low = 1 |
| Exposure | High | Internet-facing = ×3, Internal = ×1, Test-only = ×0 |
| Data sensitivity | Medium | Regulated (PCI/HIPAA/GDPR) = ×3, Sensitive = ×2, Public = ×1 |

Fix order: highest combined score first.

## SLA targets

- **Critical:** Fix before next production deploy. Block the build if unresolved.
- **High:** Fix within current sprint (≤2 weeks).
- **Medium:** Fix within 30 days.
- **Low / Info:** Backlog with acceptance criteria and review date.

## Communication rules

- Never frame a security finding as "we'll fix it later" without a date and ticket.
- Always tie the finding to a potential business impact (breach cost, compliance penalty, reputational damage).
- Use the security debt analogy: "Deferring this is borrowing against future security."
- For stakeholders: translate technical severity into business risk language.

## Failure modes to flag immediately

- Critical or High finding without a fix SLA or assigned owner.
- More than 3 consecutive sprints of growing security backlog without a remediation sprint.
- WAF or runtime protection relied on as the only mitigation for a known High/Critical finding with no remediation plan.
- Dependency with a published CVE at Critical/High severity running in production beyond the SLA window.
