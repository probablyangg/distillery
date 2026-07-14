#!/usr/bin/env bash
#
# story-commits.sh — turn uncommitted changes into a story-telling commit
# history via an LLM (OpenRouter). Each commit gets a three-word, Bob
# Ross-coded title and a short, precise plain-language body.
#
# Mirrors the `/story-commits` Claude Code skill so it can run from a
# plain terminal.
#
# Usage:
#   scripts/story-commits.sh [-m MODEL] [-e ENV_FILE] [-y] [-n]
#
#   -m MODEL     Override the LLM model id (default: $OPENROUTER_MODEL).
#   -e ENV_FILE  Env file to load (default: .env.local, then .env.example).
#   -y           Yes to all: commit without an interactive confirm.
#   -n           Dry run: print the plan, make no commits.
#   -h           Help.
#
# Keys are read from the env file (OPENROUTER_API_KEY, OPENROUTER_BASE_URL,
# OPENROUTER_MODEL) — same names as .env.example.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
MODEL_OVERRIDE=""
ENV_FILE=""
ASSUME_YES=0
DRY_RUN=0

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while getopts ":m:e:ynh" opt; do
  case "$opt" in
    m) MODEL_OVERRIDE="$OPTARG" ;;
    e) ENV_FILE="$OPTARG" ;;
    y) ASSUME_YES=1 ;;
    n) DRY_RUN=1 ;;
    h) usage 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage 1 ;;
    :) echo "Option -$OPTARG needs an argument" >&2; usage 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
for cmd in git jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: '$cmd' is required but not installed." >&2; exit 1; }
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "error: not inside a git repo." >&2; exit 1; }
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Load env file (KEY=VALUE lines; tolerant of quotes and export prefixes)
# ---------------------------------------------------------------------------
if [[ -z "$ENV_FILE" ]]; then
  if [[ -f .env.local ]]; then ENV_FILE=".env.local"
  elif [[ -f .env ]]; then ENV_FILE=".env"
  elif [[ -f .env.example ]]; then ENV_FILE=".env.example"
  fi
fi

if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # Strip comments/blank lines, then source. Values may be quoted.
  source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/^[[:space:]]*export[[:space:]]\+//')
  set +a
  echo "› loaded env from $ENV_FILE"
else
  echo "warn: no env file found; relying on current environment." >&2
fi

OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
MODEL="${MODEL_OVERRIDE:-${OPENROUTER_MODEL:-openai/gpt-5}}"

[[ -n "$OPENROUTER_API_KEY" ]] || { echo "error: OPENROUTER_API_KEY is empty. Set it in your env file." >&2; exit 1; }

echo "› model: $MODEL"

# ---------------------------------------------------------------------------
# Gather the working-tree state
# ---------------------------------------------------------------------------
STATUS="$(git status --short)"
if [[ -z "$STATUS" ]]; then
  echo "Working tree is clean — nothing to tell a story about."
  exit 0
fi

# Full diff of tracked changes (staged + unstaged), plus a listing of the
# head of each untracked file so the model can narrate new files too.
DIFF="$(git diff HEAD 2>/dev/null || git diff)"

UNTRACKED_BLOCK=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  UNTRACKED_BLOCK+=$'\n'"===== NEW FILE: $f ====="$'\n'
  UNTRACKED_BLOCK+="$(head -c 4000 "$f" 2>/dev/null || true)"$'\n'
done < <(git ls-files --others --exclude-standard)

# Guard against enormous payloads: cap the diff we send.
MAX_DIFF_BYTES=120000
if [[ ${#DIFF} -gt $MAX_DIFF_BYTES ]]; then
  DIFF="${DIFF:0:$MAX_DIFF_BYTES}"$'\n\n[diff truncated for length]'
fi

# ---------------------------------------------------------------------------
# Build the prompt (embeds the story-commits skill rules)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT='You are a storyteller at heart, voice of Bob Ross: warm, forgiving, slightly funny, very human. You turn a git working tree into a clean, story-telling commit history.

THE FORMAT (non-negotiable) for every commit:
1. Title: EXACTLY three words. Short, wholesome, slightly funny, very human — never a label, never solemn. Lowercase. Articles and small words count as words ("two happy trees", "no sneaky spans", "tucking memories in"). No prefixes, no colons, no scope tags, no punctuation except what the phrase itself needs (a comma is fine).
2. Body: a short, plain-language explanation, 3–6 lines. Explain the change from first principles. Define any specialized term the first time it appears. Short sentences, active voice, concrete examples over abstractions. Tasteful humor welcome but never at the cost of precision. Name the real things (the hash, the schema, the migration, the endpoint) so a reader finishes knowing exactly what changed. Wrap lines at ~65 chars.

HOW TO GROUP:
- One commit per coherent idea. Order commits by dependency graph — foundations before the things that import them — so history read oldest-first is the system growing up. Typical arc: workspace scaffolding → contracts → domain packages (dependency order) → db/migrations → apps → evals → scripts → docs. Related config rides with the code it configures; docs close the story.
- Every file that appears in the working tree must land in exactly one commit. Never drop a file. Never put one file in two commits.
- If you cannot find three true words for a group, the grouping is wrong — regroup.

OUTPUT: Return ONLY valid JSON, no markdown fences, matching:
{"commits":[{"title":"three word title","body":"multi-line body here","paths":["path/one","path/two"]}]}
Titles must be exactly three words. Paths must be repo-relative and come only from the provided working-tree state.'

USER_PROMPT="Here is the current working tree.

=== git status --short ===
${STATUS}

=== git diff HEAD ===
${DIFF}
${UNTRACKED_BLOCK}

Produce the commit plan as JSON."

# ---------------------------------------------------------------------------
# Call OpenRouter
# ---------------------------------------------------------------------------
REQUEST="$(jq -n \
  --arg model "$MODEL" \
  --arg sys "$SYSTEM_PROMPT" \
  --arg usr "$USER_PROMPT" \
  '{
    model: $model,
    messages: [
      {role: "system", content: $sys},
      {role: "user", content: $usr}
    ],
    temperature: 0.7,
    response_format: {type: "json_object"}
  }')"

echo "› asking the model to plan the chapters…"
RESPONSE="$(curl -sS --fail-with-body \
  -X POST "${OPENROUTER_BASE_URL%/}/chat/completions" \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: https://github.com/local/story-commits" \
  -H "X-Title: story-commits" \
  --data "$REQUEST")" || { echo "error: OpenRouter request failed:" >&2; echo "$RESPONSE" >&2; exit 1; }

CONTENT="$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')"
[[ -n "$CONTENT" ]] || { echo "error: empty response from model:" >&2; echo "$RESPONSE" | jq . >&2 2>/dev/null || echo "$RESPONSE" >&2; exit 1; }

# Strip any accidental code fences before parsing.
CONTENT="$(echo "$CONTENT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

echo "$CONTENT" | jq -e '.commits | type == "array" and length > 0' >/dev/null 2>&1 \
  || { echo "error: model did not return a valid commit plan:" >&2; echo "$CONTENT" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Show the plan
# ---------------------------------------------------------------------------
echo
echo "════════════════════ commit plan ════════════════════"
echo "$CONTENT" | jq -r '.commits[] | "▸ \(.title)\n\(.body | gsub("\n";"\n  ") | "  \(.)")\n  files: \(.paths | join(", "))\n"'
echo "══════════════════════════════════════════════════════"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "(dry run — no commits made)"
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Commit these chapters? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted."; exit 0; }
fi

# ---------------------------------------------------------------------------
# Commit chapter by chapter
# ---------------------------------------------------------------------------
COUNT="$(echo "$CONTENT" | jq '.commits | length')"
for i in $(seq 0 $((COUNT - 1))); do
  TITLE="$(echo "$CONTENT" | jq -r ".commits[$i].title")"
  BODY="$(echo "$CONTENT" | jq -r ".commits[$i].body")"

  # Reset the index so each commit stages only its own paths.
  git reset -q

  # Stage this chapter's paths (NUL-delimited to survive spaces).
  echo "$CONTENT" | jq -r ".commits[$i].paths[]" | while IFS= read -r p; do
    git add -- "$p" 2>/dev/null || echo "  warn: could not stage '$p'" >&2
  done

  if git diff --cached --quiet; then
    echo "⤫ nothing staged for \"$TITLE\" — skipping."
    continue
  fi

  printf '%s\n\n%s\n' "$TITLE" "$BODY" | git commit -q -F -
  echo "✓ committed: $TITLE"
done

git reset -q

# ---------------------------------------------------------------------------
# Show the poem
# ---------------------------------------------------------------------------
echo
echo "════════════════════ the poem ════════════════════"
git log --oneline -n "$COUNT"
echo "═══════════════════════════════════════════════════"
echo

REMAIN="$(git status --short)"
if [[ -n "$REMAIN" ]]; then
  echo "note: some changes are still uncommitted:"
  echo "$REMAIN"
else
  echo "the tree is clean."
fi
