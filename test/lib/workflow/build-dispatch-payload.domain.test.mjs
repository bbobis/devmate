// @ts-check
// DN-3: domain-context section of the dispatch payload. The regression
// contract is byte-identity — a repo without domains (no domainContext
// option, absent state, or zero matches) produces exactly the pre-DN-3
// payload.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDispatchPayload } from '../../../lib/workflow/build-dispatch-payload.mjs';
import { estimateTokens } from '../../../lib/context/estimate-tokens.mjs';

/** @typedef {import('../../../lib/types.mjs').DomainContextState} DomainContextState */

const COMPLETENESS_FIELDS = {
  objective: 'Implement the planned tasks',
  outputFormat: 'Return a typed result object',
  toolGuidance: 'Use repo-configured verification commands only',
  boundaries: 'Touch only files matching the persona editable globs',
};

/**
 * Temp repo fixture: a plan.json plus a .devmate/contexts/ dir for real
 * context files, so the injected reader exercises path resolution against
 * repoRoot exactly as production would.
 * @returns {{ dir: string, planPath: string, writeContext: (rel: string, content: string) => void, cleanup: () => void }}
 */
function repoFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-domain-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      tasks: [
        {
          id: 'AC-1',
          tddApproach: {
            testType: 'unit',
            testFiles: ['src/foo.spec.ts'],
            redSummary: 'fails before implementation',
          },
        },
      ],
    }),
    'utf8',
  );
  return {
    dir,
    planPath,
    writeContext: (rel, content) => {
      const filePath = join(dir, ...rel.split('/'));
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** @returns {(p: string) => string|null} */
function fsReader() {
  return (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
}

/** @returns {import('../../../lib/types.mjs').DevmateConfig} */
function singleRootConfig() {
  return {
    schemaVersion: 1,
    personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
    verification: { unitTest: 'run-unit-tests' },
  };
}

/**
 * @param {DomainContextState['matches']} matches
 * @returns {DomainContextState}
 */
function domainState(matches) {
  return { schemaVersion: 1, resolvedAt: '2026-07-11T00:00:00.000Z', matches };
}

/**
 * @param {string} contextFile
 * @returns {DomainContextState['matches'][0]}
 */
function billingMatch(contextFile) {
  return {
    domain: 'billing',
    score: 0.7,
    matchedKeywords: ['invoice'],
    matchedGlobs: ['packages/billing/src/**'],
    contextFile,
    relatedDomains: ['orders'],
  };
}

test('dispatch domain section › no domainContext option -> no section, and absent/empty state is byte-identical', () => {
  const fixture = repoFixture();
  try {
    /** @param {object} [extra] */
    const build = (extra = {}) =>
      buildDispatchPayload({
        ...COMPLETENESS_FIELDS,
        persona: 'frontend',
        tasks: [{ id: 'AC-1' }],
        planPath: fixture.planPath,
        config: singleRootConfig(),
        ...extra,
      });

    const withoutOption = build();
    assert.doesNotMatch(withoutOption, /## Domain context/);

    const withNullState = build({
      domainContext: { state: null, repoRoot: fixture.dir, readFile: fsReader() },
    });
    const withEmptyMatches = build({
      domainContext: { state: domainState([]), repoRoot: fixture.dir, readFile: fsReader() },
    });
    assert.equal(withNullState, withoutOption);
    assert.equal(withEmptyMatches, withoutOption);
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › two resolved domains render in rank order with content, globs, related line', () => {
  const fixture = repoFixture();
  try {
    fixture.writeContext(
      '.devmate/contexts/billing.md',
      '# Billing\n\nInvariant: never double-charge an invoice.\n',
    );
    fixture.writeContext(
      '.devmate/contexts/orders.md',
      '# Orders\n\nEntry: packages/orders/src/index.ts\n',
    );
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: singleRootConfig(),
      domainContext: {
        state: domainState([
          billingMatch('.devmate/contexts/billing.md'),
          {
            domain: 'orders',
            score: 0.45,
            matchedKeywords: ['order'],
            matchedGlobs: ['packages/orders/src/**'],
            contextFile: '.devmate/contexts/orders.md',
            relatedDomains: [],
          },
        ]),
        repoRoot: fixture.dir,
        readFile: fsReader(),
      },
    });

    const billingAt = payload.indexOf('## Domain context: billing');
    const ordersAt = payload.indexOf('## Domain context: orders');
    assert.ok(billingAt !== -1 && ordersAt !== -1, 'both domains must render');
    assert.ok(billingAt < ordersAt, 'rank order must be preserved');
    // Rendered after persona context, before the task list.
    assert.ok(payload.indexOf('## Persona context') < billingAt);
    assert.ok(ordersAt < payload.indexOf('## Task list'));

    assert.match(payload, /- Owns: packages\/billing\/src\/\*\*/);
    assert.match(payload, /- Related: orders/);
    assert.match(payload, /Invariant: never double-charge an invoice\./);
    assert.match(payload, /Entry: packages\/orders\/src\/index\.ts/);
    assert.match(payload, /- Related: \[none\]/);
    assert.doesNotMatch(payload, /over budget|context file missing/);
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › oversized context file renders a LOUD digest + pointer naming the path', () => {
  const fixture = repoFixture();
  try {
    fixture.writeContext(
      '.devmate/contexts/billing.md',
      `# Billing\n## Invariants\n${'x'.repeat(20000)}\n`,
    );
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: singleRootConfig(),
      domainContext: {
        state: domainState([billingMatch('.devmate/contexts/billing.md')]),
        repoRoot: fixture.dir,
        readFile: fsReader(),
      },
    });

    assert.match(
      payload,
      /\[context file over budget — digest below; read \.devmate\/contexts\/billing\.md for the rest\]/,
    );
    assert.match(payload, /Headings: # Billing \| ## Invariants/);
    // The full 20k-char paste must NOT be in the payload (loud cap, TCM-9).
    assert.doesNotMatch(payload, /x{1000}/);

    // Total domain-section token estimate stays within the default budget.
    const sectionStart = payload.indexOf('## Domain context: billing');
    const sectionEnd = payload.indexOf('## Task list');
    const section = payload.slice(sectionStart, sectionEnd);
    assert.ok(
      estimateTokens(section) <= 1500,
      `domain section must fit DOMAIN_CONTEXT_MAX_TOKENS, got ~${estimateTokens(section)}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › missing context file renders header + globs + missing note', () => {
  const fixture = repoFixture();
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: singleRootConfig(),
      domainContext: {
        state: domainState([billingMatch('.devmate/contexts/billing.md')]),
        repoRoot: fixture.dir,
        readFile: fsReader(), // file never written
      },
    });

    assert.match(payload, /## Domain context: billing/);
    assert.match(payload, /- Owns: packages\/billing\/src\/\*\*/);
    assert.match(payload, /\[context file missing: \.devmate\/contexts\/billing\.md\]/);
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › null contextFile renders the no-file-declared note', () => {
  const fixture = repoFixture();
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: singleRootConfig(),
      domainContext: {
        state: domainState([
          {
            domain: 'billing',
            score: 0.5,
            matchedKeywords: ['invoice'],
            matchedGlobs: [],
            contextFile: null,
            relatedDomains: [],
          },
        ]),
        repoRoot: fixture.dir,
        readFile: fsReader(),
      },
    });

    assert.match(payload, /## Domain context: billing/);
    assert.match(payload, /- Owns: \[no globs matched\]/);
    assert.match(payload, /\[no context file declared for this domain\]/);
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › malformed domainContext option fails fast naming the field', () => {
  const fixture = repoFixture();
  try {
    /** @param {*} domainContext  Deliberately malformed — testing the fail-fast path. */
    const build = (domainContext) => () =>
      buildDispatchPayload({
        ...COMPLETENESS_FIELDS,
        persona: 'frontend',
        tasks: [{ id: 'AC-1' }],
        planPath: fixture.planPath,
        config: singleRootConfig(),
        domainContext,
      });

    // A provided-but-broken wiring input must throw, never silently render
    // every domain as "context file missing" (poka-yoke, targetAcs style).
    assert.throws(
      build({ state: domainState([billingMatch('.devmate/contexts/billing.md')]), repoRoot: fixture.dir }),
      /domainContext\.readFile must be a function/,
    );
    assert.throws(
      build({ state: domainState([]), repoRoot: '', readFile: fsReader() }),
      /domainContext\.repoRoot must be a non-empty string/,
    );
    assert.throws(
      build({ state: domainState([]), repoRoot: fixture.dir, readFile: fsReader(), maxTokens: 0 }),
      /domainContext\.maxTokens must be a positive finite number/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('dispatch domain section › maxTokens override tightens the budget', () => {
  const fixture = repoFixture();
  try {
    fixture.writeContext(
      '.devmate/contexts/billing.md',
      `# Billing\n${'content line\n'.repeat(60)}`,
    );
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: singleRootConfig(),
      domainContext: {
        state: domainState([billingMatch('.devmate/contexts/billing.md')]),
        repoRoot: fixture.dir,
        readFile: fsReader(),
        maxTokens: 50,
      },
    });

    // ~200 tokens of content against a 50-token budget -> digest fallback.
    assert.match(payload, /context file over budget/);
  } finally {
    fixture.cleanup();
  }
});
