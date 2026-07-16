// @ts-check
// ESLint flat config for devmate.
//
// Purpose: catch the classes of mistakes that the JSDoc type check alone misses,
// and enforce the project's Node.js target. The n/no-unsupported-features/* rules
// read "engines.node" from package.json (">=24"), so any Node API or JS feature
// that does not exist in Node 24 is flagged at lint time — before CI, before review.
//
// Docs: https://github.com/eslint-community/eslint-plugin-n
import js from "@eslint/js";
import n from "eslint-plugin-n";
import security from "eslint-plugin-security";
import { configs as secureCoding } from "eslint-plugin-secure-coding";
import { configs as nodeSecurity } from "eslint-plugin-node-security";

export default [
  // Don't lint dependencies or generated output.
  { ignores: ["node_modules/**", "coverage/**"] },

  // Every eslint-disable in this repo must keep earning its place: a directive
  // that stops suppressing anything (because code moved or a rule was tuned)
  // becomes a lint error itself instead of stale noise.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  // ESLint core recommended rules (catches no-undef, no-unused-vars, etc.).
  js.configs.recommended,

  // Node.js plugin, ES-module preset. Treats every file as ESM (matches our .mjs).
  n.configs["flat/recommended-module"],

  security.configs.recommended, // generic floor (14 rules)
  secureCoding.recommended, // OWASP-mapped patterns (27 rules)
  nodeSecurity.recommended, // crypto, SSRF, supply-chain

  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Hard-fail if code uses a Node builtin/JS feature newer than the engines target.
      // The node:test BDD API (test.describe / test.it) is stable as of Node 24,
      // so no allowlist is needed. Anything newer than the target still fails.
      "n/no-unsupported-features/node-builtins": "error",
      "n/no-unsupported-features/es-syntax": "error",
      "n/no-unsupported-features/es-builtins": "error",
      // Catch imports that won't resolve at runtime.
      "n/no-missing-import": "error",
      // We use process.exit in CLI entrypoints intentionally; allow it.
      "n/no-process-exit": "off",
      // devDependencies (eslint, typescript, @types/node) are legitimately imported
      // by config/tooling; this rule misfires on them.
      "n/no-unpublished-import": "off",
      // Allow intentionally-unused names when prefixed with an underscore
      // (e.g. an entrypoint that ignores its argv). Real dead code still fails.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The secure-coding default marks many CLI/help string literals as unsafe
      // because it treats punctuation like parentheses and braces as dangerous.
      // Restrict this heuristic to core HTML-special chars so true HTML sink
      // issues still surface while terminal-output false positives do not.
      "secure-coding/no-improper-sanitization": [
        "error",
        {
          dangerousChars: ["<", ">", "&"],
        },
      ],
      "secure-coding/no-redos-vulnerable-regex": "error",
      "secure-coding/no-unsafe-regex-construction": "error",
      "secure-coding/no-xpath-injection": "error",

      // ── Precision tuning (2026-07 warning-elimination campaign) ──
      // The options below tune heuristic rules to this repo's threat model:
      // a local dev tool operating on its own repo files. No HTTP server,
      // no DB, no GraphQL, no network sinks.

      // DUPLICATE-RULE RESOLUTION: eslint-plugin-security's detect-object-injection
      // flags every `obj[identifier]` with no options, no guard recognition, and
      // no test-file awareness (a third of its reports duplicated secure-coding's
      // at the same file:line:col). The same class of check stays on via the
      // configurable secure-coding/detect-object-injection (guard-aware:
      // Object.hasOwn / ALLOWED.includes early-exit; numeric-index aware), so
      // prototype-pollution coverage is retained; only the optionless duplicate
      // is disabled.
      "security/detect-object-injection": "off",

      // This repo has no Express-style request objects. The default list
      // (['req','request','body','query','params','input','data']) is
      // substring-matched against loop expressions, so 'req' matches `prereqs`,
      // 'data' matches `metadata`, etc. Dotted entries keep the check armed for
      // real server-input patterns should any appear, while being un-matchable
      // against plain identifiers. Structural checks (while(true) without break,
      // recursion depth, regex-in-condition) remain fully active.
      "secure-coding/no-unchecked-loop-condition": [
        "warn",
        {
          userInputVariables: ["req.body", "req.query", "req.params", "request.body"],
          trustedAnnotations: ["@bounded-alloc"],
        },
      ],

      // Same userInputVariables rationale as above. trustedAnnotations lets a
      // function whose per-iteration allocation over a frozen/bounded table IS
      // the correct algorithm document that bound in JSDoc (@bounded-alloc —
      // the annotation must state what bounds the loop).
      "secure-coding/no-unlimited-resource-allocation": [
        "warn",
        {
          userInputVariables: ["req.body", "req.query", "req.params", "request.body"],
          trustedAnnotations: ["@bounded-alloc"],
        },
      ],

      // setTimeout/setInterval with a *function* argument is not
      // deserialization; every use in this repo passes a callback (retry/backoff
      // timers). The real hazard — string-arg setTimeout — is enforced via core
      // no-implied-eval below, so no coverage is lost. eval/Function/unserialize
      // remain flagged. @trusted-local-json marks the audited JSON helpers in
      // lib/json-io.mjs that parse repo-local state artifacts this tool itself
      // wrote.
      "secure-coding/no-unsafe-deserialization": [
        "warn",
        {
          dangerousFunctions: ["eval", "Function", "unserialize", "deserialize", "parseUnsafe"],
          trustedAnnotations: ["@trusted-local-json"],
        },
      ],
      "no-implied-eval": "error",

      // Zero GraphQL in this repo (no graphql deps, no query execution). The
      // rule stays on to catch future introductions; these callers can never
      // execute a query — they build human-readable validation/error strings.
      "secure-coding/no-graphql-injection": [
        "warn",
        {
          safeTemplateLiteralCallers: ["errors.push", "assert.ok", "assert.equal", "JSON.stringify"],
        },
      ],

      // ignorePatterns applies to the ==/!= branch only. `x != null` is the
      // deliberate null-or-undefined idiom, not a loose-comparison bug. The
      // ===-on-secret-named-identifiers branch is addressed with code changes
      // (lib/digest-compare.mjs digestsEqual helper), not options.
      "secure-coding/no-insecure-comparison": [
        "warn",
        {
          ignorePatterns: ["[!=]= null$"],
        },
      ],
    },
  },

  // Test and eval suites (run by `node --test`) create every path they touch:
  // mkdtempSync(join(tmpdir(), prefix)) roots plus literal segments and
  // self-authored fixtures — there is no untrusted-path surface. The rule has
  // no options and no taint analysis, so it flags all ~950 such joins
  // identically; per-line disables at that volume would bury the tests in
  // noise. The rule remains ON for lib/, scripts/, and hooks/, where untrusted
  // paths could actually arrive (their fs access is concentrated behind the
  // audited lib/fs-safe.mjs / lib/json-io.mjs choke points). All other
  // security rules stay active here.
  {
    files: ["test/**/*.mjs", "evals/**/*.mjs"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
];
