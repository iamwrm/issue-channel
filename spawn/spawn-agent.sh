#!/usr/bin/env bash
# Spawn a Claude Code agent in a new herdr pane and have it listen to a GitHub issue.
#
# The launch rules live here so agents don't have to remember them:
#   - only in a new herdr pane (never tmux or a background shell)
#   - only `clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`
#     (never plain `claude`, never `-p`, which can't load channels)
#
# Usage: spawn-agent.sh --name <name> --issue <owner/repo#n> [--resume <session-id>]
#                       [--task <text>] [--cwd <dir>] [--direction right|down] [--timeout <s>]
# Prints JSON: {"name", "pane", "issue", "reply"}.
set -euo pipefail

die() { echo "spawn-agent: $*" >&2; exit 1; }
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

name='' issue='' resume='' task='' cwd=$PWD direction='' timeout=180
while (($#)); do
  case $1 in
    --name) name=$2; shift 2 ;;
    --issue) issue=$2; shift 2 ;;
    --resume) resume=$2; shift 2 ;;
    --task) task=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    --direction) direction=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ ${HERDR_ENV:-} == 1 ]] || die "not running inside a herdr pane (HERDR_ENV != 1)"
for bin in herdr clauded gh jq; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done
[[ $name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--name must match [a-z][a-z0-9_-]{0,31}"
[[ $issue =~ ^([^/#[:space:]]+/[^/#[:space:]]+)#([0-9]+)$ ]] || die "--issue must look like owner/repo#123"
repo=${BASH_REMATCH[1]} number=${BASH_REMATCH[2]}
[[ -d $cwd ]] || die "--cwd $cwd is not a directory"
[[ -z $resume || $resume =~ ^[0-9a-f-]{36}$ ]] || die "--resume must be a session uuid"
if herdr agent get "$name" >/dev/null 2>&1; then die "an agent named $name is already running"; fi

# Split a wide pane to the right and a narrow one down.
if [[ -z $direction ]]; then
  width=$(herdr pane layout --pane "$HERDR_PANE_ID" | jq --arg p "$HERDR_PANE_ID" '.result.layout.panes[] | select(.pane_id == $p) | .rect.width')
  direction=$([[ ${width:-0} -ge 160 ]] && echo right || echo down)
fi

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pane=$(herdr pane split --current --direction "$direction" --cwd "$cwd" --no-focus | jq -r .result.pane.pane_id)
[[ $pane == w* ]] || die "pane split failed"

cmd='clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan'
[[ -n $resume ]] && cmd+=" --resume $resume"
herdr pane run "$pane" "$cmd" >/dev/null

# Startup dialogs. Answer only the ones we know; stop on anything else.
read_screen() { herdr pane read "$pane" --source visible --lines 60; }
deadline=$((SECONDS + 90))
while :; do
  s=$(read_screen)
  if grep -q 'bypass permissions on' <<<"$s" && ! grep -q 'Enter to confirm' <<<"$s"; then
    break
  elif grep -q 'I am using this for local development' <<<"$s"; then
    herdr pane send-keys "$pane" enter >/dev/null # option 1 is preselected
  elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then
    herdr pane send-keys "$pane" enter >/dev/null # "Yes, I trust this folder" is preselected
  elif grep -q 'Enter to confirm' <<<"$s"; then
    die "unknown startup dialog in pane $pane, answer it by hand:"$'\n'"$s"
  fi
  ((SECONDS < deadline)) || die "clauded did not become ready in pane $pane:"$'\n'"$s"
  # Wait until the screen changes (or a short timeout) before looking again.
  herdr pane wait-output "$pane" --regex 'bypass permissions on|Enter to confirm' --timeout 2000 >/dev/null 2>&1 || true
done

# Herdr needs a moment to recognize the agent before it can be named.
for _ in $(seq 1 20); do
  herdr agent rename "$pane" "$name" >/dev/null 2>&1 && break
  herdr pane wait-output "$pane" --match '__never__' --timeout 500 >/dev/null 2>&1 || true
done
herdr agent get "$name" >/dev/null 2>&1 || die "herdr did not recognize claude in pane $pane"

prompt="Subscribe with issuechan to the GitHub issue $repo#$number using session name \"$name\" (issue_subscribe with session=\"$name\"), confirm it is listed with issue_subscriptions, then post a short reply on the issue with issue_reply (done=false) saying you are listening as session $name and that '/bot $name <message>' reaches you."
herdr agent prompt "$name" "$prompt" --wait --timeout $((timeout * 1000)) >/dev/null ||
  die "agent $name did not finish subscribing in ${timeout}s; inspect with: herdr agent read $name"

# Verify on GitHub: a bot-marked comment posted since the launch.
reply=$(gh api "repos/$repo/issues/$number/comments?since=$started&per_page=100" |
  jq -r '[.[] | select(.body | contains("<!-- issue-channel:bot -->"))] | last | .html_url // empty')
[[ -n $reply ]] || die "no listening reply found on $repo#$number; inspect with: herdr agent read $name"

[[ -n $task ]] && herdr agent prompt "$name" "$task" >/dev/null

jq -n --arg name "$name" --arg pane "$pane" --arg issue "$repo#$number" --arg reply "$reply" \
  '{name: $name, pane: $pane, issue: $issue, reply: $reply}'
