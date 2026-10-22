# spawn-agent.sh

Start a Claude Code agent in a new herdr tab or tmux window and have it listen to a GitHub or Linear issue through issuechan. One command, with the launch rules built in, so an agent can't start Claude Code the wrong way.

It runs from inside a [herdr](#herdr-and-tmux) pane (`herdr` in `PATH`) or a tmux session (`tmux` in `PATH`). Both are optional: the server and the issuechan channel work without it. Set `ISSUECHAN_DIR` to your issue-channel checkout to use the paths below.

```sh
$ISSUECHAN_DIR/spawn/spawn-agent.sh --name worker1 --issue owner/repo#42
$ISSUECHAN_DIR/spawn/spawn-agent.sh --name worker1 --issue linear:ENG#123
$ISSUECHAN_DIR/spawn/spawn-agent.sh --name worker1 --issue owner/repo#42 --resume <fork id> --task "..."
```

Output (JSON): `{"name", "tab", "pane", "issue", "reply", "agent"}`, where `reply` is the URL of the agent's own "listening" comment and `agent` its `cc:<id8>` tag from that comment. A non-zero exit means no agent was left running: the script closed the tab it created, so a retry under the same name is safe.

| Option | |
|---|---|
| `--name` | herdr agent name (tmux: window name) **and** issuechan session name (`[a-z][a-z0-9_-]{0,31}`), so `/bot <name> …` reaches it |
| `--issue` | `owner/repo#n` (GitHub) or `linear:TEAM#n` (Linear ENG-123 = `linear:ENG#123`; checked with `skills/issue-channel/scripts/linear.mjs`, which needs `linear.env`) |
| `--resume` | start from a session log, e.g. an edited fork from [`../session-fork`](../session-fork/README.md) |
| `--task` | prompt sent after it is listening (not waited for) |
| `--cwd` | working directory (default: current) |
| `--timeout` | seconds to wait for the subscribe step (default 180); after it the script still looks for the reply for 60 s before failing |
| `--mux` | `herdr` or `tmux`; default: herdr inside a herdr pane (`HERDR_ENV=1`), else tmux inside tmux (`$TMUX` set) |

## What it enforces

- It runs only inside herdr (`HERDR_ENV=1`) or tmux (`$TMUX`) and always uses a **new** herdr tab in the caller's workspace (`--no-focus`) or a **new** tmux window in the caller's session (`-d`, no focus change), labelled with the agent name. It never splits a pane (split panes keep shrinking as agents pile up) and never uses a background shell.
- It launches only `$ISSUECHAN_LAUNCHER --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan [--resume <id>]`, never with `-p`, because `-p` can't load channels. `ISSUECHAN_LAUNCHER` defaults to `claude`; set it if you start Claude Code through a wrapper.
- It answers only known startup dialogs:
  - the dev-channel warning ("I am using this for local development", preselected)
  - "trust this folder" ("Yes, I trust this folder", preselected)

  Any other `Enter to confirm` dialog stops the script and prints the screen.
- It verifies instead of assuming: it fails unless (with herdr) herdr recognizes the agent and **that agent's own** reply (prefix `🤖 <name> · cc:<id> ·`, bot marker) appears on the issue after launch. Another agent's reply on the same issue doesn't count.
- The verdict is the reply, not the prompt: a subscribe prompt that outlives `--timeout` is not a failure while the reply can still arrive.
- A failure after the tab exists closes the tab (the last screen is printed first), so a failed spawn never leaves an agent that subscribes later unseen.

## Steps

1. Create a tab (`herdr tab create --label <name> --no-focus`) and run the `claude` command in its root pane.
2. Clear the startup dialogs until the prompt footer (`bypass permissions on`) shows.
3. `herdr agent rename <pane> <name>`.
4. `herdr agent prompt <name> --wait`: subscribe with `session=<name>`, check `issue_subscriptions`, and post a "listening" reply (`done=false`).
5. Find the agent's own reply on the issue (up to `--timeout` + 60 s), then send `--task` if given. On any failure from step 1 on, close the tab.

Teardown: `herdr agent prompt <name> "Unsubscribe from the issue"`, then `herdr tab close <tab>`.

## herdr and tmux

The steps are the same; only the pane calls differ.

| Step | herdr | tmux |
|---|---|---|
| New tab | `herdr tab create --label <name> --no-focus` | `tmux new-window -d -n <name>`, tagged `@issuechan_agent=<name>` |
| Name already taken | `herdr agent get <name>` succeeds | a window tagged `<name>` runs something other than a shell (an agent that exited back to its shell, or crashed, frees the name) |
| Read the screen, send keys | `herdr pane read` / `send-keys` | `tmux capture-pane -p` / `send-keys` |
| Prompt | `herdr agent prompt <name> [--wait]` | bracketed paste (`load-buffer` + `paste-buffer -p`) then Enter, so a multi-line prompt is one message. tmux can't tell when the agent is idle, so the reply check waits `--timeout` + 60 s instead |
| Failure cleanup | `herdr tab close <tab>` | `tmux kill-window -t <window>` |

tmux teardown: paste "Unsubscribe from the issue" the same way, check the screen, then `tmux kill-window -t <window>`.

```sh
p=%7   # the "pane" from the JSON output
printf '%s' 'Unsubscribe from <owner/repo>#<n> with issue_unsubscribe and confirm with issue_subscriptions. Do not post on the issue.' |
  tmux load-buffer -b td - && tmux paste-buffer -p -r -d -b td -t "$p" && sleep 0.5 && tmux send-keys -t "$p" Enter
tmux capture-pane -p -t "$p" | tail -15          # wait until it confirms
tmux kill-window -t <tab>
```

The new window gets the tmux server's environment, not the caller's. Put anything the agent needs (for example `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` on a box without nonessential traffic) in a wrapper and point `ISSUECHAN_LAUNCHER` at it.

### Live test, tmux (2026-10-22, Claude Code 2.1.308, tmux 3.5a, no herdr)

Throwaway mainbot#67 (now closed), spawned from inside a Claude Code session in tmux:

| Test | Result |
|---|---|
| Spawn + two-line `--task` | ✅ listening reply with its own `cc:` id in **15.5 s**; the task arrived as one message and was answered on the issue |
| Same name while that agent runs | ✅ exit 1, `an agent named tmuxtest is already running` |
| `/bot tmuxtest ping` | ✅ pushed to the child, `pong (tmuxtest)`, 👀 → 🚀 |
| Agent never replies (repo doesn't exist, `--timeout 5`) | ✅ exit 1 after 68 s, last screen printed, window closed |
| Teardown (paste unsubscribe, `kill-window`) | ✅ `issue_subscriptions` empty, window gone |

Not tested with tmux: `--resume`, Linear `--issue`, two spawns at once.

## Live test (2026-10-09, Claude Code 2.1.295)

On a throwaway issue (#18, now closed):
- **Spawn:** `--name spawntest`. The dev-channel dialog was answered, and the agent was listening with its reply posted in **22 s**.
- **Routing:** `/bot spawntest ping` reached the child. It replied "pong: session spawntest, listening to owner/repo#18", and the comment went 👀 → 🚀.
- **Teardown:** the child unsubscribed (`issue_subscriptions` came back empty), and the pane was closed.

Re-tested after the switch to tabs (2026-10-09, throwaway #21, now closed): `--name tabtest` opened its own tab (`w2:tH`) and left the caller's tab with the same pane count. The listening reply was posted in **25 s**, and the tab was closed after the test.

Re-tested 2026-10-21 (Claude Code 2.1.280 via `clauded`, mainbot#58; throwaways #59, #60, now closed) with log-triage tasks:

| Test | Before this fix | After |
|---|---|---|
| Subscribe prompt outlives `--timeout 3` | ❌ exit 1, but the agent subscribed and posted "listening" anyway: the caller saw a failure and a live agent stayed on the issue | ✅ exit 0 with its own reply and `cc:` id (26 s) |
| Agent never replies (repo doesn't exist) | (not run) | ✅ exit 1 after `--timeout` + 60 s, last screen printed, tab closed, no agent left |
| Two spawns on one issue at once | ❌ both reported the same (the other agent's) reply URL | ✅ each its own reply and `cc:` id (40 s, 172 s) |
| Fresh spawn + task, `/bot <name>` routing, crash then respawn under the same name, teardown | ✅ (2026-10-21, before the fix) | |

Linear `--issue` (2026-10-21, throwaway REN-117, now Done; GitHub #61 alongside as a regression check, now closed): both spawned at once. `linear:REN#117` came up in 34 s with its own reply and `cc:` id, and `/bot ltlin …` on REN-117 was answered in 7 s. The GitHub spawn took 155 s, also with its own reply.

A subscribe step can take ~3 min under load (rt5: the agent loaded the issue-channel skill and read the issue's history first), which is why the timeout alone doesn't decide.

`--resume` together with a `session-fork handoff` was live-tested on 2026-10-09. There was no double subscribe, but the child stays registered on the server under the parent's session name. See [the session-fork live test](../session-fork/README.md#live-test-full-replace-myself-run-with-handoff-2026-10-09).

# restart-agent.sh

Restart a Claude Code agent **in place** (same herdr pane), optionally into a **CLM-compacted fork** of its session, so it continues with a smaller, edited context. Works on another agent or, run detached, on the agent itself. Usage and rules: the header of [`restart-agent.sh`](restart-agent.sh) and the skill's [`reference/ops.md`](../skills/issue-channel/reference/ops.md#restart-or-compact-yourself).

Steps: wait until idle → (with `--fork <live.md>`, a `session-fork mirror --full` the agent edited) `session-fork fork` (dropping the turn that did the edit; stale files refused; `live.diff.md` written) + `handoff`, parent state parked → `/exit` → `$ISSUECHAN_LAUNCHER … --resume <id or fork>` in the same pane, answering the known dialogs → restore the herdr name → check the channel process → send `--then`.

**Harnesses:** Claude Code only for now (`$ISSUECHAN_LAUNCHER`, `--resume`, Claude Code's session logs and dialogs). Support for other agents such as **Codex** and **pi** is planned (see `BACKLOG.md`).

## Live test (2026-10-10, throwaway issue, `clauded`)

A test agent spawned with `spawn-agent.sh` got a codeword + number in one turn, a secret word in another, and a long file summary. A `/bot` asking for them was posted **during** each switch.

| Test | What | Result |
|---|---|---|
| T1 | Plain restart in place | ✅ 8 s, same session; the `/bot` posted while it was gone was delivered after the resume and answered from the kept context; 👀 → 🚀 |
| T2 | Compact (drop the secret turn, replace the summary) + restart, run from another session | ⚠️ 8 s, fork took over the pane with the subscription, `/bot` answered, codeword kept, 58.5k → 50.8k tokens, **but the secret leaked**: the turn that ran `mirror`/wrote the plan quotes the dropped turn and was kept |
| T2b | Same after the fix (the plan-writing turn is always dropped) | ✅ secret absent from the fork's log and unknown to the agent (it said so instead of guessing), codeword kept, 59.2k → 45.9k tokens |
| T3 | The agent compacts **itself**: mirror, plan, `restart-agent.sh` detached, turn ends | ✅ waited for its turn to end, 14 s, 58.6k → 41.8k tokens; the fork followed `--then` and posted as `cc:<fork id>` with the codeword. The agent first asked for confirmation because the instructions came as pasted text |

# no-compact

Reset a Claude Code agent's context **without a summary**, the counterpart of Pi's `/no-compact` (piagent-config `packages/pi-history-notes`). It's for a big session that sat idle past the prompt-cache TTL (1h): resuming it would re-write its whole context to the cache on the next request. After a no-compact, the next request starts from the system prompt, the tools and a short note, and the agent reads back from the old log only what it needs.

```text
/bot !no-compact               every session listening on the issue (usually one)
/bot !no-compact <name>        only that session; an unknown name resets nothing
<further lines>                a normal /bot for the new session, delivered by its own channel
```

**Matched by code, never by the model.** Anything the model reads is already a request over the stale context, which is the cost being avoided. So `parseTrigger` (`core/lib.mjs`) recognises exactly that first line, and the channel (`core/engine.mjs` `noCompact`) doesn't deliver it. Instead it:

1. keeps the cursor **before** the command and marks it (`resetBy`), because the swap hands this state file over: the successor's channel replays the command, sees it was handled, and delivers the text after it as a normal `/bot` (a channel message with 👀, not typed or pasted text);
2. calls the adapter's `noCompact`, which starts [`no-compact.mjs`](no-compact.mjs) detached. A missing herdr pane fails here: the channel posts why and delivers the text as a normal `/bot`;
3. holds back every later `/bot` (unflushed, so the successor gets them). If the swap fails before the old session exits, the channel listens again and delivers what it held.

`no-compact.mjs` runs `restart-agent.sh --no-compact` and then posts the outcome on the issue (`no-compact: reset cc:<old> → cc:<new>`), with no model involved. `restart-agent.sh` waits until the agent is idle, then runs `session-fork reset <old>`, `/exit`, `handoff`, and resumes the fork in the same pane, typing in the text.

`session-fork reset` writes a fork that keeps **no turn**: one note with the old log's path, how to read it back (`session-fork mirror <old>`, bounded reads, verify live state, follow chained resets), and the **last exchange verbatim** (request and final reply, capped at 16k chars, about 4k tokens) so "continue" needs no reads. The old log is untouched: `--resume <old id>` is the rollback.

There is no automatic reset (decided on REN-115). By hand, for another agent: `restart-agent.sh --pane <p> --session <id> --no-compact [--then "<prompt>"]`.

## Live test (2026-10-12, Claude Code via `clauded`, throwaway mainbot#50, now closed)

An agent spawned with `spawn-agent.sh` did realistic log triage over synthetic app/nginx logs, then got a no-compact with a follow-up question.

| Run | What | Result |
|---|---|---|
| R1 | `/bot !no-compact` + question; the text was still typed in with `--then` | ✅ swap in 12 s, reply from code, correct answer, 👀 → 🚀. **But** herdr turned the multi-line text into a `<pasted_content>` block, which agents treat with caution. Hence the redesign below. |
| R2 | `/bot !no-compact nctest2` + question; the successor's channel replays the command (`resetBy`) and delivers the text natively | ✅ swap in 12 s (idle → reset → exit → handoff → resume). The successor got a real channel message (`origin=channel`), answered correctly from the verbatim last exchange with no reads, and marked it done (👀 → 🚀). The old log was untouched. |

Request sizes in R2 (API usage, input + cache read + cache write):

| | Tokens | Cache write |
|---|---|---|
| Old session, last request | 43,072 | 1,114 |
| Successor, first request | 28,286 | 2,853 |

The floor is the system prompt plus tools (~28–35k here), so the saving is the context above it. That's small in a test session and large for a 200k+ session. Not measured: a truly cold cache after more than 1h idle. The successor's system-prompt prefix can still be warm from other sessions that share it, while the old session's own context cannot.
