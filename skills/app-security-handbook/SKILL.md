---
name: app-security-handbook
description: Application security — shift-left, secure design, OWASP-aligned coding, finding triage, and security debt management.
triggers: ['secure', 'security', 'auth', 'authentication', 'authorization', 'vulnerability', 'threat model', 'owasp', 'sanitize', 'validate input', 'sql injection', 'xss', 'csrf', 'audit', 'pentest', 'sast', 'dast', 'finding', 'cve']
tags: ['security', 'owasp', 'authentication', 'authorization', 'vulnerability', 'threat-modeling', 'secure-coding', 'compliance']
negative_triggers: ['hydrate', 'seed', 'init config']
user-invocable: false
---

# Application Security Handbook

> Core principle: surface security concerns at requirements and design — not just at runtime scans.

## Common Path by Task

| Task | Load |
|---|---|
| Reviewing a feature or user story | [refs/security-requirements.md](refs/security-requirements.md) |
| Architecture or design decisions | [refs/secure-design.md](refs/secure-design.md) |
| Writing or reviewing code | [refs/secure-coding.md](refs/secure-coding.md) |
| Triaging scanner output (SAST/DAST/SCA) | [refs/finding-triage.md](refs/finding-triage.md) |
| Threat modeling | [refs/threat-modeling.md](refs/threat-modeling.md) |
| Security debt and prioritization | [refs/security-debt.md](refs/security-debt.md) |

## Pre-output gate

Before emitting any finding, recommendation, or code change, pass the checklist in [refs/secure-coding.md](refs/secure-coding.md#pre-output-checklist).
