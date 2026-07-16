# Pragmatic Programmer — Security Rules

> Load when: touching auth, API boundaries, input handling, config, credentials, or any data storage.
> Source: Tips 72 (Minimize Attack Surface) and 73 (Apply Patches Quickly).

## Hard Rules
- **Never** store credentials, API keys, or secrets in source code or version control.
- **Always sanitize external input** before using it in queries, renders, or shell commands. Input is an attack vector.
- Apply **Principle of Least Privilege**: request only permissions needed, for only as long as needed.
- Default configuration must be the **most secure option**, not the most convenient.
- **Encrypt all sensitive data** at rest and in transit. Never store PII or passwords in plain text.
- **Do not roll your own crypto.** Use vetted libraries and third-party auth providers.

## Password Handling (NIST guidelines)
- Do not restrict passwords below 64 characters
- Do not truncate passwords
- Do not prevent paste in password fields
- Do not impose arbitrary composition rules
- Do not require periodic rotation without reason

## Failure modes to flag immediately
- Hardcoded credentials anywhere in code or tests
- Missing input validation at API/form boundaries
- Plaintext storage of sensitive data
- Overly permissive CORS or auth bypass during development left in production
- SQL/NoSQL injection vectors via unescaped input
