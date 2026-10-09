# session-fork: CLM-style context editing for Claude Code

Fork a Claude Code session log into an **edited copy** and start a new session from it with `clauded --resume <id>`. It serves two uses:

1. **Context cleanup:** an agent replaces itself with a successor whose history is trimmed and summarized.
2. **Dispatch:** an agent hands a job to a worker that starts with only the context it needs, listening on its own issue.

The idea comes from [Context Language Models](https://github.com/facebookresearch/context-language-models) and [lolipopshock/pi-clm](https://github.com/lolipopshock/pi-clm): the context is a file that the model edits, and the edited version becomes its next input. pi-clm does this live inside Pi on every request. Claude Code has no extension point for that, so here the edit happens **between sessions**: the agent edits a copy of its own session log, and a new session resumes the copy.

The prompts that use this tool are in [`../PROMPTS.md`](../PROMPTS.md): "Replace myself with an edited-context successor" and "Dispatch to another issue". Active work is tracked in [#14](https://github.com/iamwrm/mainbot/issues/14).

## How it works

```
 PARENT  clauded session A  (herdr pane 1)            ~/.claude/projects/<cwd>/A.jsonl
 ┌──────────────────────────────────────┐             ┌──────────────────────────────┐
 │ turn 1  human: subscribe to #12      │──appends───►│ user ─► assistant ─► tool... │
 │ turn 2  /bot commit                  │             │   (chain linked by           │
 │ turn 3  /bot consolidate  (big)      │             │    parentUuid; never edited) │
 │ turn 4  /bot do #13                  │             └──────────────┬───────────────┘
 │ turn 5  /bot move #9                 │                            │
 │ turn 6  /bot work on #14  ◄ running  │                            │ ① mirror
 └──────────────────────────────────────┘                            ▼
                                                      ┌──────────────────────────────┐
   session-fork.mjs mirror A                          │ [[TURN 1 from=human ~39k]]   │
   "context as a file": one block per turn ─────────► │ [[TURN 2 from=channel ~4k]]  │
                                                      │ [[TURN 3 from=channel ~23k]] │
                                                      │ ...                          │
                                                      │ [[TURN 6 ... incomplete]]    │
                                                      └──────────────┬───────────────┘
                                                                     │ ② the agent edits
                                                                     ▼   (writes plan.json)
                                                      ┌──────────────────────────────┐
                                                      │ replace 2-4 → "summary: ..." │
                                                      │ drop    6                    │
                                                      │ note    → "you are the       │
                                                      │            successor; ..."   │
                                                      └──────────────┬───────────────┘
                                                                     │ ③ fork
                                                                     ▼
   session-fork.mjs fork A plan.json                  ~/.claude/projects/<cwd>/B.jsonl
   • new uuid B, sessionId rewritten                  ┌──────────────────────────────┐
   • parentUuid re-linked across the cuts             │ turn 1  (kept as-is)         │
   • whole turns only → tool pairs stay intact        │ note    summary of 2-4       │
   • incomplete turn always dropped                   │ turn 5  (kept as-is)         │
                                                      │ note    handoff              │
              ~121k tokens ──────────────────────►    └──────────────┬───────────────┘
                                   ~54k tokens                       │
                                                                     │ ④ handoff (optional)
   ~/.local/state/issue-channel/                                     │
     cc-A.json ──copy cursor + open /bot requests──► cc-B.json       │
     (parent then calls issue_unsubscribe)                           │
                                                                     ▼ ⑤ resume
 CHILD   herdr pane 2:  clauded --dangerously-skip-permissions \
                          --dangerously-load-development-channels server:issuechan \
                          --resume B
 ┌──────────────────────────────────────┐
 │ sees: turn 1 · summary · turn 5 ·    │  ◄── /bot on #12 now reaches B,
 │       handoff note                   │      from where A stopped
 └──────────────────────────────────────┘
```

| Step | Who | What |
|---|---|---|
| ① mirror | tool | Prints the session as numbered turns, like pi-clm's `LIVE_CONTEXT` file |
| ② edit | agent | Decides what to keep, summarize or drop, and writes `plan.json` |
| ③ fork | tool | Writes a new, valid session log `B.jsonl`; `A.jsonl` stays untouched |
| ④ handoff | tool + agent | Copies issuechan state to B, then A unsubscribes |
| ⑤ resume | herdr | Starts B in a new pane; the edited history becomes its context |

## Usage

```sh
node session-fork.mjs mirror  <session-id|path>              # numbered turns
node session-fork.mjs fork    <session-id|path> <plan.json>  # prints {id, dest, entries, tokens, before}
node session-fork.mjs handoff <from-session-id> <to-session-id>
```

An agent finds its own id in `$CLAUDE_CODE_SESSION_ID`. Logs are looked up under `~/.claude/projects/*/<id>.jsonl`, and the fork is written next to the source.

**`mirror`** prints one block per turn:
```
[[TURN 3 from=channel tokens~23131]]
user: <first 400 chars of the prompt>
tools: Bash×3, Read×1, mcp__issuechan__issue_reply×2
assistant: <first 400 chars of the final reply>
```
Turn 0 is the preamble. A turn starts at each prompt (typed or channel) and runs until the next one. `incomplete` marks a turn with an unanswered `tool_use`.

**Plan:**
```json
{
  "title": "successor of mainbot #12",
  "ops": [
    { "op": "replace", "from": 2, "to": 4, "note": "Summary of turns 2-4: ..." },
    { "op": "drop", "from": 6, "to": 6 }
  ],
  "note": "You are the successor of session A on iamwrm/mainbot#12. ..."
}
```
- Ranges are inclusive. A turn may appear in only one op, and turn 0 can't be edited.
- `replace` puts one user note, plus a short assistant "Noted.", where the turns were. `drop` removes them.
- `note` is appended at the end, and `title` becomes the session name.

**What `fork` guarantees**
- A new uuid, with `sessionId` (and `session_id`) rewritten. `parentUuid` is re-linked in order, which bridges every cut.
- Only whole turns are edited, so `tool_use`/`tool_result` pairs never break. Incomplete turns, such as the one running the fork, are always dropped.
- Metadata that points into the old log (`last-prompt`, `file-history-*`, `queue-operation`) is not copied.
- The source log is never modified.

**`handoff`** copies `~/.local/state/issue-channel/cc-<from>.json` to `cc-<to>.json`, including subscriptions, cursors and open 👀 requests, so the child resumes delivery where the parent stopped. Order: copy, then the parent calls `issue_unsubscribe`, then start the child.

## Spawning the child

Use [`../spawn/spawn-agent.sh`](../spawn/README.md) with `--resume <fork id>`. It starts the fork in a new herdr tab with the only allowed launch command (`clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`), answers the startup dialogs, names the agent, has it subscribe under that session name, and checks its "listening" reply.

- A fork has a new `CLAUDE_CODE_SESSION_ID`, so it starts with **no** subscriptions unless `handoff` copied them.
- With several agents on one issue, each needs its own session name, so that `/bot <name>` reaches the right one.

## Decisions

- **Fork and resume, not live editing.** Claude Code can't swap context mid-session, so the edited context becomes a new session. That is also how a successor or worker is spawned.
- **pi-clm's idea, not pi-clm itself.** We don't run a Pi worker. The idea (context as a file the model edits) is used to build a Claude Code successor's history.
- **Whole turns plus free-text notes.** pi-clm lets the model rewrite any block. Rebuilding Claude Code's JSONL from free text risks breaking tool pairs and metadata, so v1 only touches whole turns. Trimming large tool outputs inside a kept turn could come later.

## Live test (2026-10-09)

1. `mirror` of the #12 session showed 6 turns. The plan replaced turns 2–4 with a one-line summary plus a canary word, `PERIWINKLE`. It dropped turn 6 and appended "you are a forked copy, don't post on GitHub". The estimate went from ~121k to ~54k tokens.
2. In a new herdr split: `clauded --dangerously-skip-permissions --resume <fork id>`. It loaded at once, with the plan's title as its session name.
3. Asked from memory, with no tools allowed:

| Question | Where the answer was | Child's answer |
|---|---|---|
| Canary word | only in the inserted note | ✅ PERIWINKLE |
| #13 commit | only in the note | ✅ 29a29ef |
| DESIGN.md commit | in a kept turn | ✅ 307c0e7 |
| IDs of the two consolidated #12 comments | only in a **dropped** turn | ✅ "not in my context", no guessing |
| How many turns it sees | — | ✅ describes exactly the edited chain |

## Live test: full replace-myself run with handoff (2026-10-09)

Unattended, on a throwaway issue (#23, deleted afterwards):
1. `spawn-agent.sh --name rmparent` started the parent, which was given a codeword (`MARIGOLD-23`) and a number (`4177`).
2. A script posted an untargeted `/bot canary-N` every ~15 s, 12 in all, from before the switch until after it.
3. The parent got the PROMPTS.md "Replace myself" prompt, with the successor name `rmchild`. It ran `mirror` and `fork` (~53k → ~0.6k tokens, with the codeword kept in the note), then `handoff`, then `issue_unsubscribe` (13:30:29), then `spawn-agent.sh --resume`. The child connected at 13:30:38 and posted its listening reply at 13:31:11.

| Check | Result |
|---|---|
| Every canary handled | ✅ all 12 were handled exactly once and all show 🚀: 1–5 by the parent, 6–12 by the child (checked against both session logs) |
| Child remembers the edited history | ✅ `/bot rmchild` asked for the codeword, and the child answered `MARIGOLD-23` / `4177` from memory |
| Double subscribe after `--resume` + `handoff` | ✅ none. The auto-resume subscribed once, the spawn prompt got "already subscribed", and the session was renamed to `rmchild` |

Bugs found (fixed afterwards, see the rerun below):
- **Delivery after unsubscribe.** canary-5 (posted 13:30:34) was delivered to the parent at 13:30:36, after `issue_unsubscribe` had returned. A long poll already in flight still delivers, because `pollLoop` doesn't check `s.stopped` before `maybeDeliver`.
- **A delivery at child startup is dropped.** The child's auto-resume replayed canary-5 right after connecting, before "Channel notifications registered". Claude Code never showed it, yet the channel counted it as delivered: cursor 362, comment in `open_requests`. canary-5 was handled only because of the bug above, and because the child looked up its open requests by hand. Fix idea: delay the first delivery until the channel is registered, or re-deliver open requests on the first poll.
- **Stale session registration.** The copied state carried `session: rmparent`, so the child registered on the server as `rmparent`. The later `issue_subscribe(session=rmchild)` took the "already subscribed" path, which skips the server `PUT`, so the server still listed only `rmparent`. `/bot rmchild …` still worked, because an unknown one-word target counts as untargeted, but `/bot rmparent …` would also reach the child. The child's own `issue_unsubscribe` then deleted only `rmchild`, which left an orphaned `rmparent` row that had to be removed by hand. Fix idea: on a session rename, re-register (`PUT` the new name, `DELETE` the old one).

## Usage accounting (ccusage)

Copied assistant replies lose their `requestId` and get `usage` with every number set to 0, while `message.id` is kept. So `npx ccusage` counts them as 0 for the fork and keeps crediting them to the parent, and a fork shows up only once it makes its own requests. Before this ([PR #17](https://github.com/iamwrm/mainbot/pull/17)), totals were already correct, because ccusage dedupes on `message.id` + `requestId`. But `ccusage session` credited each duplicate to whichever log it read first, so a fork took over ~881k tokens (~$0.54) of the parent's usage in the live test.

The cost is that Claude Code reads the last reply's `usage` as a context-size hint until the fork's first request. For a fork, that number described the parent's larger context anyway.

## Status

- [x] `mirror` / `fork` / `handoff` with unit tests (`node --test`)
- [x] Edited fork resumes in a herdr pane and remembers exactly the edited history
- [x] "Replace myself" and "dispatch" prompts in PROMPTS.md
- [x] `handoff` live-tested: no `/bot` lost during the switch (with two delivery bugs found, see above)
- [x] Spawn a child with the channel loaded in herdr, child replies, `/bot <name>` routes to it ([`spawn-agent.sh`](../spawn/README.md) live test)
- [x] Full replace-myself run: fork + `handoff` + parent unsubscribes + `spawn-agent.sh --resume`
- [x] Fix: delivery after unsubscribe, dropped startup delivery, stale session registration (`channel/channel.test.mjs`)

## Test

```sh
node --test
```
