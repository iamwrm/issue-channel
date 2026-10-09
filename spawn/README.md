# spawn-agent.sh

Start a Claude Code agent in a new herdr pane and have it listen to a GitHub issue through issuechan. One command, with the launch rules built in, so an agent can't start Claude Code the wrong way.

```sh
projects/issue-channel/spawn/spawn-agent.sh --name worker1 --issue iamwrm/mainbot#42
projects/issue-channel/spawn/spawn-agent.sh --name worker1 --issue iamwrm/mainbot#42 --resume <fork id> --task "..."
```

Output (JSON): `{"name", "pane", "issue", "reply"}`, where `reply` is the URL of the agent's "listening" comment.

| Option | |
|---|---|
| `--name` | herdr agent name **and** issuechan session name (`[a-z][a-z0-9_-]{0,31}`), so `/bot <name> …` reaches it |
| `--issue` | `owner/repo#n` |
| `--resume` | start from a session log, e.g. an edited fork from [`../session-fork`](../session-fork/README.md) |
| `--task` | prompt sent after it is listening (not waited for) |
| `--cwd` | working directory (default: current) |
| `--direction` | `right` or `down` (default: right if the caller's pane is at least 160 columns wide) |
| `--timeout` | seconds to wait for the subscribe step (default 180) |

## What it enforces

- It runs only inside herdr (`HERDR_ENV=1`) and always uses a **new** split pane (`--no-focus`), never tmux or a background shell.
- It launches only `clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan [--resume <id>]`: never plain `claude` and never `-p`, because `-p` can't load channels.
- It answers only known startup dialogs:
  - the dev-channel warning ("I am using this for local development", preselected)
  - "trust this folder" ("Yes, I trust this folder", preselected)

  Any other `Enter to confirm` dialog stops the script and prints the screen.
- It verifies instead of assuming: it fails unless herdr recognizes the agent and a bot-marked comment appears on the issue after launch.

## Steps

1. Split a pane and run the `clauded` command.
2. Clear the startup dialogs until the prompt footer (`bypass permissions on`) shows.
3. `herdr agent rename <pane> <name>`.
4. `herdr agent prompt <name> --wait`: subscribe with `session=<name>`, check `issue_subscriptions`, and post a "listening" reply (`done=false`).
5. Check the reply on GitHub, then send `--task` if given.

Teardown: `herdr agent prompt <name> "Unsubscribe from the issue"`, then `herdr pane close <pane>`.

## Live test (2026-10-09, Claude Code 2.1.295)

On a throwaway issue (#18, now closed):
- **Spawn:** `--name spawntest`. The dev-channel dialog was answered, and the agent was listening with its reply posted in **22 s**.
- **Routing:** `/bot spawntest ping` reached the child. It replied "pong: session spawntest, listening to iamwrm/mainbot#18", and the comment went 👀 → 🚀.
- **Teardown:** the child unsubscribed (`issue_subscriptions` came back empty), and the pane was closed.

Not tested yet: `--resume` together with a `session-fork handoff`. The child would auto-resubscribe from the copied state and then also get the subscribe prompt.
