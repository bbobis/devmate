---
name: Application Security Handbook
description: Apply when writing, reviewing, or designing code that touches auth, authorization, input handling, data storage, secrets, or dependencies. Enforces shift-left security, OWASP Top 10 rules, threat modeling, finding triage, and security debt management.
applyTo: "**"
---

# Application Security Handbook

> Core principle: security concerns must be addressed at requirements and design, not only at runtime scans.

## Load the right ref for your task

- **Reviewing a user story, feature, or requirement** — follow [skills/app-security-handbook/refs/security-requirements.md](../../skills/app-security-handbook/refs/security-requirements.md)
- **Making architecture or design decisions** — follow [skills/app-security-handbook/refs/secure-design.md](../../skills/app-security-handbook/refs/secure-design.md)
- **Writing or reviewing code** — follow [skills/app-security-handbook/refs/secure-coding.md](../../skills/app-security-handbook/refs/secure-coding.md)
- **Triaging SAST, DAST, SCA, or WAF findings** — follow [skills/app-security-handbook/refs/finding-triage.md](../../skills/app-security-handbook/refs/finding-triage.md)
- **Designing a feature with user-controlled input or privileged actions** — follow [skills/app-security-handbook/refs/threat-modeling.md](../../skills/app-security-handbook/refs/threat-modeling.md)
- **Managing a vulnerability backlog or communicating risk to stakeholders** — follow [skills/app-security-handbook/refs/security-debt.md](../../skills/app-security-handbook/refs/security-debt.md)

## Pre-output checklist

Before emitting any code change or security finding, verify:

- [ ] All user/external input validated and sanitized before use (OWASP A03)
- [ ] All DB queries parameterized — no string concatenation (OWASP A03)
- [ ] Authorization checks enforced server-side on every path (OWASP A01)
- [ ] Secrets and credentials absent from source code and logs
- [ ] PII, passwords, and tokens never logged in plain text (OWASP A02)
- [ ] Error messages safe for client consumption — no stack traces (OWASP A05)
- [ ] Default configuration is the most secure option (OWASP A05)
- [ ] Standard auth libraries used — no custom JWT or session logic (OWASP A07)
- [ ] Security requirements derived alongside functional requirements
- [ ] Every finding includes a file path and line range evidence pointer
