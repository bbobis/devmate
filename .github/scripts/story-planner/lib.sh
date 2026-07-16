#!/usr/bin/env bash
# Shared helpers for the devmate story-planner pipeline.
# Sourced by the other scripts in this directory.
#
# Invocation model (mirrors .github/workflows/enrich-issue.yml):
#   - prompt is piped to `copilot -s` via stdin (avoids arg-length limits)
#   - `-s` keeps stdout clean for posting as a comment
#   - `--add-dir` grants read access to each checked-out repo directory
#   - `--allow-tool='shell(...)'` is a read-only allow-list (deny takes precedence)
#   - user-controlled strings are expanded via `printf '%s\n'`, never inlined
#
# INVOCATION_MODE:
#   prompt (default, proven) — embeds the agent body (from .github/agents/*.md)
#                               in the piped prompt; no --agent flag.
#   agent                      — passes `--agent <name>` and relies on the copied
#                               .github/agents/*.md for discovery (verify on your CLI).
set -euo pipefail

# Marker embedded in every posted plan comment so reruns can minimize the prior one.
export STORY_PLAN_MARKER='<!-- devmate-story-plan-v1 -->'

# Read-only tool allow-list shared across planner + rubber-duck runs.
copilot_allow_tools() {
  printf '%s\n' \
    "--allow-tool=shell(git:*)" \
    "--allow-tool=shell(rg:*)" \
    "--allow-tool=shell(grep:*)" \
    "--allow-tool=shell(find:*)" \
    "--allow-tool=shell(cat:*)" \
    "--allow-tool=shell(ls:*)" \
    "--allow-tool=shell(head:*)" \
    "--allow-tool=shell(tail:*)" \
    "--allow-tool=shell(wc:*)"
}

# Emit one `--add-dir <abs>` per checked-out repo directory listed in ADD_DIRS
# (space- or newline-separated). Always includes the workspace root.
copilot_add_dirs() {
  local dir
  printf -- '--add-dir\n%s\n' "$PWD"
  if [ -n "${ADD_DIRS:-}" ]; then
    for dir in $ADD_DIRS; do
      [ -d "$dir" ] && printf -- '--add-dir\n%s\n' "$PWD/$dir"
    done
  fi
}

# Strip YAML frontmatter (lines between the first two `---` fences) from a file.
strip_frontmatter() {
  awk 'BEGIN{f=0} /^---[[:space:]]*$/{f++; next} f>=2{print}' "$1"
}

# Run copilot CLI: reads prompt from stdin, writes clean stdout to $1.
# Usage: run_copilot <out-file> [--agent <name>]
run_copilot() {
  local out="$1"; shift
  local args=()
  while [ $# -gt 0 ]; do args+=("$1"); shift; done
  # Build the arg list: -s --no-ask-user + add-dirs + allow-tools + extra (--agent).
  local full=(-s --no-ask-user)
  local d t
  while IFS= read -r d; do full+=("$d"); done < <(copilot_add_dirs)
  while IFS= read -r t; do full+=("$t"); done < <(copilot_allow_tools)
  full+=("${args[@]}")
  copilot "${full[@]}" > "$out"
}
