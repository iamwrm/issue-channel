# Decisions

The durable decisions behind issue-channel's agent tooling. One entry per decision, newest last. When a decision is replaced, the old entry stays and is marked **Superseded by Dn**. Issues (GitHub, Linear) link here; they don't hold decisions themselves (D14).

Dates are HKT.

## D1. A Linear issue the agent listens to goes In Progress
2026-10-10 · [#4](https://github.com/iamwrm/issue-channel/pull/4)

When the agent creates or subscribes to a Linear issue at the user's request, it sets the issue to **In Progress** (`linear.mjs create … --state in-progress`, or after subscribing unless already started or closed). Both "In Progress" and "In Review" have type `started` in team REN; the first by the team's order wins.

## D2. Comment edits never wake the agent
2026-10-10

Edits to issue comments (GitHub or Linear) are buffered and delivered with the next `/bot` as a diff against what the agent saw. Only a newly created `/bot` comment wakes the agent, even if an edit adds `/bot`.

## D3. One script restarts an agent in place, optionally into a compacted fork
2026-10-10 · [#5](https://github.com/iamwrm/issue-channel/pull/5)

`spawn/restart-agent.sh` restarts in the **same pane**. With `--fork <file>` it resumes an edited fork that takes over the subscriptions, cursors and open requests. A self-restart runs detached so the agent's turn can end; `--then` tells the resumed agent what to do next. A `/bot` from the user is the trusted way to ask an agent to restart itself.

## D4. The turn that does the edit is never part of the fork
2026-10-10 · [#5](https://github.com/iamwrm/issue-channel/pull/5)

That turn quotes what it drops; in testing, a dropped secret leaked through it. `--keep-last` opts out.

## D5. CLM-compact is a real edit of the full context
2026-10-10 · [#8](https://github.com/iamwrm/issue-channel/pull/8)

The agent edits its whole context block by block (keep, trim, drop, add notes). Replacing everything with one handoff note is allowed only as an explicit choice and is reported as "summary only". Before this, both of bot_01's self-restarts had replaced every turn with one note.

## D6. The edit happens in the old session, before the switch
2026-10-10 · [#8](https://github.com/iamwrm/issue-channel/pull/8)

The old session still has its full context (including its reasoning) when it decides what to keep. The fork is built from the edited file and resumed in the same pane.

## D7. Reasoning blocks are keep-or-delete placeholders
2026-10-10 · [#8](https://github.com/iamwrm/issue-channel/pull/8)

The mirror never shows reasoning text. A rewritten reasoning text is accepted by the API and ignored (the signature is the real content), so editing it would only mislead. See [`session-fork/RESULTS.md`](../session-fork/RESULTS.md).

## D8. Self-compaction goes through the neutral `live-context` skill
2026-10-10 · [#9](https://github.com/iamwrm/issue-channel/pull/9)

An agent compacts **itself** with `ctx open → edit → ctx apply`, which presents the context as an ordinary file to tidy. It never runs `session-fork mirror --full` on its own session: that tripped the model's `[reasoning_extraction]` safeguard 3 times out of 3. `mirror --full` remains for compacting **another** agent. See [DESIGN.md](../DESIGN.md#self-compaction-and-model-safeguards).

## D9. Context sizes are reported from API usage only
2026-10-11 · [#14](https://github.com/iamwrm/issue-channel/pull/14)

`ctx report` compares the API usage (input + cache read + cache write) of the old session's last request with the new session's first request. The chars/4 estimate in the restart log is labelled as an estimate and is never reported as the result (it once said −16% where the API said −45%).

## D10. Tests use realistic work
2026-10-10

Agent tooling is tested with realistic tasks (log triage, design-doc comparison, debugging, ops checks), never secret-word or hide-and-reveal games, which can look malicious. Small POC runs with throwaway `clauded` sessions come before a proposed design.

## D11. One restart per pane; one pending switch per session
2026-10-11 · [#14](https://github.com/iamwrm/issue-channel/pull/14)

`restart-agent.sh` holds a per-pane lock. A second `ctx apply` in the same turn replaces the first; an edit that leaves nothing is refused.

## D12. The issuechan state moves only after the old session has exited
2026-10-11 · [#11](https://github.com/iamwrm/issue-channel/pull/11)

`/exit` is retried after Escape (a dialog left open swallowed it once), and the subscriptions are handed to the fork only after the exit is confirmed, so a failed exit no longer leaves the running session listening to nothing.

## D13. PRs in this repo are one commit, merged by rebase
2026-10-10

Squash to one commit when asked; `gh pr merge --rebase`.

## D14. The repo is the source of truth; issues are disposable working surfaces
2026-10-11

Decisions go here, results next to the code they test ([`session-fork/RESULTS.md`](../session-fork/RESULTS.md)), open work in [`BACKLOG.md`](../BACKLOG.md), how-tos in the READMEs. An issue holds links, the request being worked on and short-lived discussion, so it can be consolidated or wiped at any time. Consolidating an issue starts by moving anything durable into the repo through a PR ([`skills/issue-channel/reference/consolidate.md`](../skills/issue-channel/reference/consolidate.md)).
