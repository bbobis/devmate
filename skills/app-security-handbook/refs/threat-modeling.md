# Application Security — Threat Modeling

> Load when: designing a new feature, reviewing a system diagram, or preparing for a security review.

## Mini threat-model flow (STRIDE)

For every significant feature or integration, walk through these five questions:

1. **Assets** — What data or functionality is being protected? What is its classification?
2. **Entry points** — Where can an attacker interact with this feature? (API endpoints, UI forms, file uploads, webhooks, queues, cron jobs.)
3. **Actors** — Who uses this legitimately? Who might abuse it? (Anonymous users, authenticated users, privileged users, external services, internal automation, malicious insiders.)
4. **Threats (STRIDE):**
   - **S**poofing — Can an actor pretend to be someone else?
   - **T**ampering — Can an actor modify data or requests in transit or at rest?
   - **R**epudiation — Can an actor deny performing an action? Is there an audit trail?
   - **I**nformation disclosure — Can an actor read data they shouldn't?
   - **D**enial of service — Can an actor degrade or stop the feature?
   - **E**levation of privilege — Can an actor gain higher access than intended?
5. **Mitigations** — For each identified threat, what control is in place or required?

## Output format for a mini threat model

```
Feature: <name>
Assets: <list data and services>
Entry points: <list>
Actors: <list>
Threats:
  - [S] <description> → mitigation: <control>
  - [T] <description> → mitigation: <control>
  - [R] <description> → mitigation: <control>
  - [I] <description> → mitigation: <control>
  - [D] <description> → mitigation: <control>
  - [E] <description> → mitigation: <control>
Open risks: <unmitigated items with justification>
```

## Abuse case pattern

For every feature with user-controlled input or privileged action:
- Write at least one **abuse case** (the evil twin of the use case).
- Example: Use case = "Admin creates weekly report." Abuse case = "Non-admin user crafts a request to create a report for a different org."
- Abuse cases become security test cases — they must fail with the expected HTTP 403 or equivalent.

## High-risk feature signals (escalate to full threat model)

- Impersonation or act-as-user flows.
- Cross-org or cross-tenant data access.
- File upload or download endpoints.
- External webhook or callback receivers.
- Direct database or shell command execution from user input.
- Payment or financial transaction processing.
