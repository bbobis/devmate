# Application Security — Finding Triage (Signal vs Noise)

> Load when: consuming SAST, DAST, SCA, WAF, or RASP output; triaging a vulnerability backlog.

## Core principle

Never dump raw scanner output at a developer. Triage first, translate second, remediate third.

A mature AppSec posture means:
- Results presented to engineering are **true positives already triaged**.
- Remediation steps are **clearly understood** before handoff.
- Where possible, a **fixed code example** accompanies the finding.
- There are **clear SLA expectations** based on severity.

## Triage steps for every finding

1. **Classify severity** — Critical / High / Medium / Low / Info.
2. **Assess true vs false positive:**
   - Does the code path actually reach the vulnerable pattern?
   - Is the input sanitized upstream before reaching this point?
   - Is the finding in dead code or a test-only path?
3. **Document evidence pointer** — file path, line range, relevant diff context.
4. **Write a plain-language description** — what the vulnerability is, not just the rule ID.
5. **Propose remediation** — concrete steps (e.g., "Switch to prepared statement on line 42") and, where applicable, a corrected code snippet.
6. **Set SLA expectation:**
   - Critical: fix before next deploy or block the build.
   - High: fix within current sprint.
   - Medium: schedule within 30 days.
   - Low / Info: backlog with acceptance criteria.

## AI-generated code: dependency verification (slopsquatting)

Hallucinated dependencies are a signature failure mode of AI-generated code: a
plausible-looking package name that does not exist — or typosquats one that
does — becomes a supply-chain entry point the moment someone publishes it.

For every diff that adds or changes an import or a manifest/lockfile entry:

1. **Resolve against the lockfile.** Every newly imported package must already
   appear in the project's lockfile. A new import with no lockfile entry is a
   finding, not a style nit.
2. **Verify existence at the registry** for any package added this lane (e.g.
   `npm view <name>` or the ecosystem equivalent) before it is installed.
3. **Check for typosquats** — compare the name against the popular package it
   resembles: case, hyphens, singular/plural, transposed letters, lookalike scopes.
4. **Severity ladder:** nonexistent package → High (blocks PR). Suspected
   typosquat or unverifiable origin → High until proven otherwise. New but
   verified dependency → Info, noting it for human review in repos with a
   restricted-dependency policy.

This check is cheap and mechanical — never skip it on the assumption that the
agent would not invent a package.

## WAF / RASP tuning rules

- Before adjusting WAF rules, document the legitimate traffic profile (origin IP range, endpoint, frequency, timing).
- High-volume legitimate traffic (batch jobs, integrations) must be allow-listed by endpoint + IP range + time window — not globally.
- Never disable a WAF rule globally to unblock one application's behavior. Scope the exception narrowly.
- Brute-force and DoS thresholds must be calibrated against peak legitimate load, not worst-case attack load.

## False-positive escalation rule

- If more than 3 consecutive findings of the same type from the same tool are confirmed false positives, suppress the rule and file a tool-tuning ticket — do not keep triaging the same noise.

## Failure modes to flag immediately

- Finding with no evidence pointer (path / line range).
- Critical or High finding being backlogged without a fix SLA.
- WAF rule disabled globally to unblock a specific app.
- Scanner output presented raw to a developer with no triage.
