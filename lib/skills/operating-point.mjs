// @ts-check
// The single source of truth for the skill-matcher operating point. Both the
// production UserPromptSubmit hook (hooks/approval-listener.mjs) and the
// skill-matching eval suite (evals/skill-matching/) import these constants, so
// the eval always measures the exact operating point customers run at — never
// matchSkills' lenient library defaults (topN 5 / minConfidence 0.1) or a
// duplicated copy that could silently drift. Mirrors how the gate-robustness
// scorer derives expectations from the canonical transition tables rather than
// restating them.
//
// TODO: calibrate topN/minConfidence against evals/skill-matching once the
// scoring-repair phase lands — current values are provisional placeholders
// carried over from the hook.

/** Maximum number of skill matches surfaced per prompt. */
export const SKILL_MATCH_TOP_N = 3;

/** Minimum confidence a match must reach to be surfaced. */
export const SKILL_MATCH_MIN_CONFIDENCE = 0.25;
