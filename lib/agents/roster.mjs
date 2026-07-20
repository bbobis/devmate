// @ts-check
/**
 * The canonical devmate agent roster.
 *
 * devmate's hooks are registered plugin-level, so they fire in EVERY Copilot
 * session — including sessions driven by a non-devmate agent or another plugin.
 * The runtime scoping (see {@link ../hooks/session-marker.mjs}) marks a session
 * "devmate-active" only when a devmate agent is dispatched, which the host
 * reports via `SubagentStart.agent_type`. That decision is only sound if we can
 * tell a devmate `agent_type` apart from someone else's — this frozen set is
 * that discriminator.
 *
 * Ground truth is the `agents/*.agent.md` frontmatter `name:` values. The list
 * is frozen here (rather than read from the filesystem at hook time) so the
 * check has no runtime FS dependency and cannot be fooled by a missing plugin
 * root; a drift test pins it to the `agents/` directory so the two never
 * silently diverge.
 */

/**
 * Every agent devmate ships, by its frontmatter `name`. Kept in sync with
 * `agents/*.agent.md` by a drift test.
 * @type {readonly string[]}
 */
export const DEVMATE_AGENT_NAMES = Object.freeze([
  'backend',
  'diagnose',
  'discovery',
  'editor',
  'frontend',
  'frontend-tester',
  'fullstack',
  'orchestrator',
  'planner',
  'router',
  'rubber-duck',
  'security',
  'spec-writer',
  'tech-design',
  'ui-ux',
]);

/** @type {ReadonlySet<string>} */
const DEVMATE_AGENT_SET = new Set(DEVMATE_AGENT_NAMES);

/**
 * Is `agentType` one of devmate's own agents?
 *
 * Used to decide whether a `SubagentStart.agent_type` should mark the session
 * as a devmate workflow. Anything not on the roster — another plugin's
 * subagent, an unknown type, a non-string — is NOT devmate, so it must never
 * flip the session into an enforced state.
 *
 * @param {unknown} agentType
 * @returns {boolean}
 */
export function isDevmateAgentType(agentType) {
  return typeof agentType === 'string' && DEVMATE_AGENT_SET.has(agentType);
}
