// @ts-check
// Stage-3 intent-gated skill menu. On new-task / steer turns — exactly where
// lexical scoring and workflow-state priors have the least to work with — the
// hook emits the FULL catalog (one line per skill, from its description) into
// the model-visible stream, so the model, which resolves paraphrase natively,
// can self-select the right skill. The menu is emitted ONLY on those turns, so
// its token cost is paid a handful of times per session, not every prompt.

/** @typedef {import('../types.mjs').SkillManifest} SkillManifest */

/** Turn intents that warrant the full menu: the model is (re)defining the work. */
export const MENU_INTENTS = Object.freeze(['new-task', 'steer-scope']);

/**
 * Whether the full menu should be emitted for a given turn intent.
 * @param {string|null|undefined} intent
 * @returns {boolean}
 */
export function shouldEmitMenu(intent) {
  return typeof intent === 'string' && MENU_INTENTS.includes(intent);
}

/**
 * The first sentence of a skill's description, trimmed and length-capped so one
 * skill never dominates the menu.
 * @param {string} description
 * @returns {string}
 */
function summarize(description) {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0].trim();
  const capped = firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}...` : firstSentence;
  return capped;
}

/**
 * Render the model-visible skill menu. One line per skill, ordered as given
 * (loadMergedSkillManifests sorts by skillId). Returns '' when there are no
 * skills, so the caller can skip emitting an empty block.
 * @param {SkillManifest[]} manifests
 * @returns {string}
 */
export function buildSkillMenu(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) return '';
  const lines = manifests.map((m) => {
    const summary = summarize(typeof m.description === 'string' ? m.description : '');
    return summary ? `- ${m.skillId}: ${summary}` : `- ${m.skillId}`;
  });
  return [
    '<devmate-skills>',
    'Available skills for this task — load the one that fits, by its id:',
    ...lines,
    '</devmate-skills>',
  ].join('\n');
}
