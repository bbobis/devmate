// @ts-check
import { resolveUnitTestCommand } from '../config/verification.mjs';

/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */

/**
 * @typedef {Object} TddApproach
 * @property {string} testType
 * @property {string[]} testFiles
 * @property {string} redSummary
 */

/**
 * @typedef {Object} PlanTask
 * @property {string} id
 * @property {TddApproach|TddApproach[]} [tddApproach]
 */

/**
 * @typedef {Object} PlanShape
 * @property {PlanTask[]} tasks
 */

/**
 * Normalize a plan task's tddApproach value to an array.
 * @param {PlanTask} task
 * @returns {TddApproach[]}
 */
function tddApproachEntries(task) {
  if (!task.tddApproach) return [];
  return Array.isArray(task.tddApproach) ? task.tddApproach : [task.tddApproach];
}

/**
 * Asserts every task in a plan has a non-empty tddApproach.testFiles list.
 * Throws on first violation.
 *
 * @param {PlanShape} plan
 * @returns {void}
 */
export function assertTddContract(plan) {
  for (const task of plan.tasks) {
    const entries = tddApproachEntries(task);
    if (entries.length === 0) {
      throw new Error(`Task ${task.id} is missing tddApproach.testFiles — cannot dispatch without TDD contract`);
    }

    const hasAnyTestFile = entries.some((entry) =>
      Array.isArray(entry.testFiles) && entry.testFiles.some((file) => typeof file === 'string' && file.trim() !== '')
    );

    if (!hasAnyTestFile) {
      throw new Error(`Task ${task.id} is missing tddApproach.testFiles — cannot dispatch without TDD contract`);
    }
  }
}

/**
 * Build the mandatory TDD preamble for a dispatch payload.
 *
 * @param {TddApproach[]} tddApproach
 * @param {DevmateConfig} config
 * @returns {string}
 */
export function buildTddPreamble(tddApproach, config) {
  const unitTest = resolveUnitTestCommand(config) || '[NOT CONFIGURED]';
  /** @type {string[]} */
  const lines = [
    '## TDD_PREAMBLE_REQUIRED',
    '',
    '- Follow Red-Green-Refactor for each acceptance criterion.',
    '- Create or update the listed test files before implementation edits.',
    `- Unit test command: ${unitTest}`,
    '',
    '### Per-AC test contract',
  ];

  for (const entry of tddApproach) {
    const files = Array.isArray(entry.testFiles) && entry.testFiles.length > 0
      ? entry.testFiles.join(', ')
      : '[MISSING TEST FILES]';
    lines.push(`- ${entry.testType}: ${files}`);
    if (typeof entry.redSummary === 'string' && entry.redSummary.trim() !== '') {
      lines.push(`  RED: ${entry.redSummary.trim()}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
