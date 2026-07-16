#!/usr/bin/env bash
# Rubber-duck critique loop: attack the plan, surface what it misses, iterate up
# to a two-revision cap (mirrors the rubber-duck agent's own two-revision limit).
#
# Inputs: plan.md (from run-planner.sh)
# Outputs: critique.md (final critique) and verdict.txt (APPROVE_PLAN | NEEDS_REVIEW)
#
# Env:
#   GH_TOKEN, ISSUE_NUMBER, REPO, ADD_DIRS, ACTION_PATH, INVOCATION_MODE
#   MAX_REVISIONS - default 2
set -euo pipefail
source "$(dirname "$0")/lib.sh"

: "${ACTION_PATH:?ACTION_PATH is required}"
MODE="${INVOCATION_MODE:-prompt}"
MAX_REVISIONS="${MAX_REVISIONS:-2}"
CRITIQUE_OUT="${CRITIQUE_OUT:-critique.md}"
VERDICT_OUT="${VERDICT_OUT:-verdict.txt}"

if [ ! -s plan.md ]; then
  echo "run-rubber-duck: plan.md is missing or empty." >&2
  exit 1
fi

iteration=0
verdict="REQUEST_REVISION:initial"

compose_critique_prompt() {
  {
    if [ "$MODE" = "prompt" ]; then
      echo "You are the devmate rubber-duck agent in CRITIQUE mode. Follow the"
      echo "role, rules, and CritiqueResult output contract below verbatim."
      echo
      echo "--- AGENT DEFINITION (begin) ---"
      strip_frontmatter "$ACTION_PATH/.github/agents/rubber-duck.md"
      echo "--- AGENT DEFINITION (end) ---"
      echo
    fi
    cat "$ACTION_PATH/.github/prompts/rubber-duck-critique.prompt.md"
    echo
    echo "## mode"
    echo "critique"
    echo
    echo "## plan (the plan to attack)"
    echo
    cat plan.md
    echo
    echo "## related-issues context (verify the plan accounts for these dependencies)"
    echo
    if [ -f related-issues.md ]; then cat related-issues.md; else echo "_none._"; fi
    echo
    echo "Output ONE FLAT JSON object matching CritiqueResult. The `verdict` field"
    echo "MUST be exactly APPROVE_PLAN or REQUEST_REVISION:<reason>. Do not modify"
    echo "files. Do not implement."
  } > critique-prompt.md
}

while [ "$iteration" -lt "$MAX_REVISIONS" ]; do
  iteration=$((iteration + 1))
  compose_critique_prompt

  if [ "$MODE" = "agent" ]; then
    run_copilot "$CRITIQUE_OUT" --agent rubber-duck < critique-prompt.md
  else
    run_copilot "$CRITIQUE_OUT" < critique-prompt.md
  fi

  verdict="$(grep -oE 'APPROVE_PLAN|REQUEST_REVISION' "$CRITIQUE_OUT" | head -n1 || true)"
  [ -n "$verdict" ] || verdict="REQUEST_REVISION:unparseable"

  echo "run-rubber-duck: iteration $iteration verdict=$verdict" >&2

  if [ "$verdict" = "APPROVE_PLAN" ]; then
    printf '%s\n' "APPROVE_PLAN" > "$VERDICT_OUT"
    exit 0
  fi

  # REQUEST_REVISION: append the critique to revisions.md and re-run the
  # planner so it produces a revised plan, then critique again next iteration.
  {
    echo "## Iteration $iteration critique"
    echo
    cat "$CRITIQUE_OUT"
    echo
  } >> revisions.md
  bash "$(dirname "$0")/run-planner.sh"
done

# Revision cap reached without an approval: do NOT auto-approve. Mark the plan
# NEEDS_REVIEW and keep the final critique as the open blockers a human must
# triage. The plan is still posted — labeled "Needs human review" (see
# post-comment.sh) — so the grooming signal isn't lost on contested stories.
printf '%s\n' "NEEDS_REVIEW" > "$VERDICT_OUT"
{
  echo "## Plan grill — open blockers (revision cap reached without approval)"
  echo
  echo "_The plan grill did not approve after $MAX_REVISIONS revision(s). The"
  echo "items below are unresolved. A human must review before implementing._"
  echo
  cat "$CRITIQUE_OUT"
} >> "$CRITIQUE_OUT.tmp"
mv "$CRITIQUE_OUT.tmp" "$CRITIQUE_OUT"
echo "run-rubber-duck: reached revision cap without approval; verdict NEEDS_REVIEW." >&2
