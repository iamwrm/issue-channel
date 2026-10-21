#!/usr/bin/env bash
# Spawn a Claude Code agent in a new herdr tab and have it listen to a GitHub issue.
#
# The launch rules live here so agents don't have to remember them:
#   - only in a new herdr tab (never a split pane, tmux or a background shell)
#   - only `$ISSUECHAN_LAUNCHER --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`
#     (ISSUECHAN_LAUNCHER defaults to `claude`; set it to a wrapper if you use one. Never `-p`, which can't load channels)
#
# Usage: spawn-agent.sh --name <name> --issue <owner/repo#n> [--resume <session-id>]
#                       [--task <text>] [--cwd <dir>] [--timeout <s>]
# Prints JSON: {"name", "tab", "pane", "issue", "reply", "agent"}. On failure the new tab is closed again,
# so a failed spawn leaves no half-started agent behind; a retry under the same name is safe.
set -euo pipefail

launcher=${ISSUECHAN_LAUNCHER:-claude}

die() { echo "spawn-agent: $*" >&2; exit 1; }
# Set once the tab exists: a failure after that closes it, so the agent can't come up later unseen.
tab=''
cleanup() { [[ -n $tab ]] && herdr tab close "$tab" >/dev/null 2>&1 && echo "spawn-agent: closed tab $tab" >&2; }
trap 'rc=$?; ((rc)) && cleanup; exit $rc' EXIT
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

name='' issue='' resume='' task='' cwd=$PWD timeout=180
while (($#)); do
  case $1 in
    --name) name=$2; shift 2 ;;
    --issue) issue=$2; shift 2 ;;
    --resume) resume=$2; shift 2 ;;
    --task) task=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ ${HERDR_ENV:-} == 1 ]] || die "not running inside a herdr pane (HERDR_ENV != 1)"
for bin in herdr "$launcher" gh jq; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done
[[ $name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--name must match [a-z][a-z0-9_-]{0,31}"
[[ $issue =~ ^([^/#[:space:]]+/[^/#[:space:]]+)#([0-9]+)$ ]] || die "--issue must look like owner/repo#123"
repo=${BASH_REMATCH[1]} number=${BASH_REMATCH[2]}
[[ -d $cwd ]] || die "--cwd $cwd is not a directory"
[[ -z $resume || $resume =~ ^[0-9a-f-]{36}$ ]] || die "--resume must be a session uuid"
if herdr agent get "$name" >/dev/null 2>&1; then die "an agent named $name is already running"; fi

# A new tab per agent: split panes keep shrinking as agents pile up.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
created=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$cwd" --label "$name" --no-focus)
tab=$(jq -r .result.tab.tab_id <<<"$created") pane=$(jq -r .result.root_pane.pane_id <<<"$created")
[[ $tab == w* && $pane == w* ]] || die "tab create failed: $created"

cmd="$launcher"' --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan'
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
  elif grep -q '❯ No, exit' <<<"$s"; then
    herdr pane send-keys "$pane" down >/dev/null # Claude Code 2.1.284 preselects "No, exit" in a new folder
  elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then
    herdr pane send-keys "$pane" enter >/dev/null # "Yes, I trust this folder" is selected
  elif grep -q 'Enter to confirm' <<<"$s"; then
    die "unknown startup dialog in pane $pane, answer it by hand:"$'\n'"$s"
  fi
  ((SECONDS < deadline)) || die "$launcher did not become ready in pane $pane:"$'\n'"$s"
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
# The prompt timing out is not the verdict (the agent may still finish): the verdict is its own reply on GitHub,
# matched by the "🤖 <name> · cc:<id> ·" prefix, so another agent's reply on the same issue can't stand in for it.
herdr agent prompt "$name" "$prompt" --wait --timeout $((timeout * 1000)) >/dev/null ||
  echo "spawn-agent: agent $name still busy after ${timeout}s, checking the issue" >&2
own_reply() {
  gh api "repos/$repo/issues/$number/comments?since=$started&per_page=100" | jq -c --arg p "🤖 $name · " \
    '[.[] | select((.body | startswith($p)) and (.body | contains("<!-- issue-channel:bot -->")))] | last
     | if . then {url: .html_url, agent: (try (.body | capture("^🤖 [^ ]+ · (?<a>[a-z]+:[0-9a-f]{8}) ·").a) catch null)} else empty end'
}
found='' grace=$((SECONDS + 60))
while :; do
  found=$(own_reply) && [[ -n $found ]] && break
  ((SECONDS < grace)) || die "no listening reply from session $name on $repo#$number; last screen of pane $pane:"$'\n'"$(read_screen | tail -25)"
  herdr pane wait-output "$pane" --match '__never__' --timeout 3000 >/dev/null 2>&1 || true
done
reply=$(jq -r .url <<<"$found") agent=$(jq -r '.agent // empty' <<<"$found")

[[ -n $task ]] && herdr agent prompt "$name" "$task" >/dev/null
tab_out=$tab tab='' # spawned: keep the tab from here on

jq -n --arg name "$name" --arg tab "$tab_out" --arg pane "$pane" --arg issue "$repo#$number" --arg reply "$reply" --arg agent "$agent" \
  '{name: $name, tab: $tab, pane: $pane, issue: $issue, reply: $reply, agent: $agent}'
