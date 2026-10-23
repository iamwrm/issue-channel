# Sourced by spawn-agent.sh and restart-agent.sh: find the command a running Claude Code agent was started with,
# so a restart (or a child it spawns) uses the same one: `clauded`, `claude` or any other wrapper, with its options.
#
#   launch_detect <session id>   sets LAUNCH_ARGV (array: the start command without --resume/--continue and the
#                                flags the scripts add), LAUNCH_ENV (array: NAME=value the wrapper or an inline
#                                `VAR=x claude` added on top of the pane's shell), LAUNCH_CHANNELS (dev channels,
#                                server:issuechan included) and LAUNCH_PID; returns 1 if it can't tell, or if
#                                the launch set a credential (…KEY/TOKEN/SECRET/PASSWORD) that can't be repeated.
#   launch_cmd [--resume <id>]   prints the full command line for a shell prompt, quoted.
#   launch_fallback <launcher>   the same variables from a plain launcher name (no detection).
#   launch_ready <read> <key> <wait> [<timeout s>]   answer the known startup dialogs until the prompt shows, using
#                                the caller's screen functions (<read> prints the screen, <key> enter|down sends a
#                                key, <wait> waits for the screen to change); prints the screen and returns 1 on an
#                                unknown dialog or the timeout.
#
# How: every process Claude Code starts (its Bash tool, the issuechan channel) has CLAUDE_CODE_SESSION_ID in its
# environment and Claude Code itself doesn't, so the parent of such a process is the agent. From there it climbs
# to the process the pane's interactive shell started: a `clauded` script that runs claude as a child is found
# there; one that `exec`s claude leaves claude's own argv, and its env changes show up in LAUNCH_ENV.
# After a /resume inside the TUI the channel still carries the old id, but the agent's Bash tool has the new one.

_launch_env_of() { { tr '\0' '\n' <"/proc/$1/environ"; } 2>/dev/null; }
# /proc/<pid>/stat is "pid (comm) state ppid …", and comm may hold spaces ("tmux: server"): split after the last ')'.
_launch_ppid() { local st; st=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; st=${st##*) }; st=${st#* }; echo "${st%% *}"; }

# An interactive shell (the pane's), as opposed to `bash /path/clauded` or `bash -c …` running something.
_launch_is_shell() {
  local -a argv; local a base
  mapfile -d '' -t argv <"/proc/$1/cmdline" 2>/dev/null || return 1
  ((${#argv[@]})) || return 1
  base=${argv[0]##*/}; base=${base#-}
  [[ $base =~ ^(ba|da|fi|k|z)?sh$ ]] || return 1
  for a in "${argv[@]:1}"; do [[ $a == -* && $a != -c ]] || return 1; done
}

launch_agent_pid() { # <session id>: the Claude Code process of that session
  local d p pp found=''
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    _launch_env_of "$p" | grep -qxF "CLAUDE_CODE_SESSION_ID=$1" || continue
    pp=$(_launch_ppid "$p"); [[ -n $pp ]] && ((pp > 1)) || continue
    _launch_env_of "$pp" | grep -qxF "CLAUDE_CODE_SESSION_ID=$1" && continue
    found=$pp; break
  done
  [[ -n $found ]] && echo "$found"
}

launch_detect() {
  local sid=$1 agent root pp a skip='' chan=''
  LAUNCH_ARGV=() LAUNCH_ENV=() LAUNCH_CHANNELS='server:issuechan' LAUNCH_PID=''
  agent=$(launch_agent_pid "$sid") || return 1
  root=$agent
  while :; do
    pp=$(_launch_ppid "$root"); [[ -n $pp ]] && ((pp > 1)) || return 1
    _launch_is_shell "$pp" && break
    root=$pp
  done
  local -a argv; mapfile -d '' -t argv <"/proc/$root/cmdline" 2>/dev/null || return 1
  ((${#argv[@]})) || return 1
  # A relative wrapper path is relative to where it was started.
  [[ ${argv[0]} == */* && ${argv[0]} != /* ]] && argv[0]=$(readlink -f "/proc/$root/cwd/${argv[0]}")
  # A wrapper script shows as `bash /path/clauded …`: run the script itself, as the user typed it.
  if [[ ${argv[0]##*/} =~ ^(ba|da|z)?sh$ && ${#argv[@]} -gt 1 && ${argv[1]} != -* ]]; then
    [[ ${argv[1]} == /* ]] || argv[1]=$(readlink -f "/proc/$root/cwd/${argv[1]}")
    [[ -x ${argv[1]} ]] && argv=("${argv[@]:1}")
  fi
  LAUNCH_ARGV=("${argv[0]}")
  for a in "${argv[@]:1}"; do
    if [[ $skip == value ]]; then skip=''; [[ $a == -* ]] || continue
    elif [[ $skip == chan ]]; then
      if [[ $a =~ ^(server|plugin): ]]; then [[ " $chan " == *" $a "* ]] || chan+=" $a"; continue; fi
      skip=''
    fi
    case $a in
      --resume|-r|--session-id) skip=value ;;
      --resume=*|--session-id=*|--continue|-c|--dangerously-skip-permissions) ;;
      --dangerously-load-development-channels) skip=chan ;;
      --dangerously-load-development-channels=*) chan+=" ${a#*=}" ;;
      *) LAUNCH_ARGV+=("$a") ;;
    esac
  done
  [[ " $chan " == *' server:issuechan '* ]] || chan+=' server:issuechan'
  LAUNCH_CHANNELS=${chan# }
  # Variables the launch added on top of the pane's shell. Only Claude Code / issue-channel / Node settings, and
  # never credentials: they would be typed into the pane, where its scrollback keeps them.
  local line name
  while IFS= read -r line; do
    name=${line%%=*}
    [[ $name =~ ^(CLAUDE_|ANTHROPIC_|ISSUECHAN_|DISABLE_|NODE_) && $name != CLAUDE_CODE_SESSION_ID ]] || continue
    if [[ $name =~ (KEY|TOKEN|SECRET|PASSWORD) ]]; then
      echo "launch: the agent's start command set $name; not repeating a credential, so set ISSUECHAN_LAUNCHER (or --launcher) to the wrapper" >&2
      return 1
    fi
    LAUNCH_ENV+=("$line")
  done < <(comm -13 <(_launch_env_of "$pp" | sort) <(_launch_env_of "$root" | sort))
  LAUNCH_PID=$root
}

launch_fallback() {
  LAUNCH_ARGV=("$1") LAUNCH_ENV=() LAUNCH_CHANNELS='server:issuechan' LAUNCH_PID=''
}

launch_cmd() {
  local -a cmd=()
  ((${#LAUNCH_ENV[@]})) && cmd+=(env "${LAUNCH_ENV[@]}")
  cmd+=("${LAUNCH_ARGV[@]}" --dangerously-skip-permissions --dangerously-load-development-channels $LAUNCH_CHANNELS "$@")
  local out='' w
  for w in "${cmd[@]}"; do
    # Keep plain words readable: quote only what needs it.
    if [[ $w =~ ^[A-Za-z0-9_./:=@%+,-]+$ ]]; then out+=" $w"; else out+=" $(printf '%q' "$w")"; fi
  done
  echo "${out# }"
}

launch_ready() {
  local read=$1 key=$2 wait=$3 deadline=$((SECONDS + ${4:-90})) s
  while :; do
    s=$($read)
    if grep -q 'bypass permissions on' <<<"$s" && ! grep -q 'Enter to confirm' <<<"$s"; then return 0
    elif grep -q 'I am using this for local development' <<<"$s"; then $key enter # option 1 is preselected
    elif grep -q '❯ No, exit' <<<"$s"; then $key down # Claude Code 2.1.284 preselects "No, exit" in a new folder
    elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then $key enter
    elif grep -q 'Enter to confirm' <<<"$s"; then echo "unknown startup dialog:"$'\n'"$s"; return 1
    fi
    ((SECONDS < deadline)) || { echo "the prompt did not show:"$'\n'"$s"; return 1; }
    $wait 'bypass permissions on|Enter to confirm'
  done
}
