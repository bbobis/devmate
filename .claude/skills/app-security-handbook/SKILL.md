---
name: app-security-handbook
description: >-
  Application security guidance for any work touching auth, authorization, input
  handling, data storage, secrets, or dependencies. Use when writing or reviewing
  security-sensitive code, designing a feature with user-controlled input or
  privileged actions, reviewing a user story for security requirements, threat
  modeling, triaging SAST/DAST/SCA/WAF findings, or managing a vulnerability
  backlog. Shift-left and OWASP-aligned: input validation, parameterized queries,
  server-side authorization, secret handling, safe error messages, secure defaults,
  and standard auth libraries. Keywords: security, vulnerability, OWASP, injection,
  XSS, CSRF, sanitize, validate input, threat model, CVE, audit, pentest.
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
