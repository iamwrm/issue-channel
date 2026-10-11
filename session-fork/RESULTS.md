# session-fork, restart-agent and live-context: test results

Measured results of the tests behind the decisions in [`docs/DECISIONS.md`](../docs/DECISIONS.md). All runs used throwaway `clauded` sessions (Claude Code 2.1.284, Opus 5.5) in herdr panes. Times are HKT.

## Restart in place (`spawn/restart-agent.sh`, 2026-10-10)

| Test | What | Result |
|---|---|---|
| T1 | Plain restart in place | ✅ 8 s, same session; a `/bot` posted during the restart was delivered afterwards and answered from the kept context |
| T2 | Compact, then restart, run from outside | ⚠️ the fork took over the pane and subscription, but a dropped secret leaked through the kept plan-writing turn → D4 |
| T2b | After the fix (that turn always dropped) | ✅ the dropped content was gone from the fork's log; 59.2k → 45.9k tokens (estimate) |
| T3 | Agent compacts itself (detached script, turn ends) | ✅ 14 s; the fork continued from `--then` under its new session id |
| Exit | Restart with a dialog left open (`/model` picker) | ✅ 10 s: Escape closes it before `/exit` (D12) |

## What the API accepts in an edited fork (POC, 13 hand-edited forks)

Every edit type resumed without an API error. What the resumed model made of it:

| Edit | Effect | Rule |
|---|---|---|
| Rewrite a reasoning block's text | accepted, **ignored** (the signature is the real content) | reasoning is keep-or-delete (D7) |
| Trim a tool output without saying so | the model compares it with other blocks and flags a contradiction | trimmed output is marked `[trimmed …]` |
| Drop a tool call but keep its result | Claude Code drops the orphan silently | the fork drops orphans explicitly and reports them |
| Drop a prompt, keep its reply | model notices "I can't see the first message" | warning, not error |
| Keep a prompt, drop every reply | model thinks it never answered | warning |
| A note in the middle of a turn | works | prefer notes between turns |
| Replace everything with one note | works; facts are treated as second-hand | allowed, flagged "summary only" (D5) |

## Self-compaction, by route

| Route | Runs | Stopped by the model's safeguard |
|---|---|---|
| Agent runs `session-fork mirror --full` on its own session | 3 (2 toy, 1 realistic) | **3 of 3** (`[reasoning_extraction]`), while it was still writing the command |
| `live-context` skill (`ctx open / apply`) | 9 (6 test agents, 3 times on bot_01) | **0** |

## `ctx` runs

Token counts marked "API" come from `ctx report` or the same usage fields; others are the API usage read by hand from the logs.

| Run | Scenario | Edit | Context (API) | Afterwards |
|---|---|---|---|---|
| ops2 · 10-10 23:05 | 502 incident triage, disk-usage check, INCIDENT.md; then "CLM-compact yourself, drop the disk task" | kept 22/31, trimmed 6, removed 9 | 57,957 → 45,178 · 14 s | window, endpoint, 209 502s, root cause recalled; disk task gone ✅ |
| S2 · 10-11 08:56 | compare 4 cache design docs against requirements, on-call side question, DECISION.md | kept 18/23, trimmed 3, removed 4 | 59,319 → 45,411 · 20 s | chosen option and numbers recalled; side question gone ✅ |
| S3 · 10-11 08:56 | failing tests → find the breaking commit with git → fix and commit; README side question | kept 17/22, trimmed 7, removed 5 | 51,925 → 42,554 · 21 s | bad commit, bug and fix recalled; side question gone ✅ |
| s3b · 10-11 14:13 | S3 again, report with `ctx report` | kept 19/24, trimmed 7, removed 5 | 51,055 → 41,008 (−20%) · 17 s | ⚠️ an edit script emptied the file once; apply accepted it and two switches raced → D11 |
| s3c · 10-11 14:21 | S3 again after the D11 fixes | kept 19/24, trimmed 3, removed 5 | 46,968 → 40,746 (−13%) · 20 s | posted the `ctx report` table unprompted ✅ |
| b3 · 10-11 15:16 | payments incident triage, revenue/refund table per region, INCIDENT.md; then "all three are finished, compact, keep what follow-ups need" (with the B3 guidance) | kept 6/31, trimmed 0, removed 25, notes 2 | 53,933 → 40,247 (−25%) · 20 s | window, error, count (289), cause and eu refund rate (10.28%) all recalled correctly ✅; ~40k is about the fixed floor |
| bot_01 #1 · 10-11 09:05 | the long-running agent itself | kept 544/544, trimmed 76 | — | ❌ the switch got stuck behind a dialog → D12 |
| bot_01 #2 · 10-11 09:19 | same, retry | kept 732/732, trimmed 103 | 429,254 → 235,433 (−45%) · 22 s | ✅ recall check passed |
| bot_01 #3 · 10-11 14:27 | same, on request | kept 657/847, trimmed 118, removed 190 reasoning blocks | 289,544 → 268,745 (−7%) · 19 s | ✅ recall check passed |

## Lessons

- Dropping old reasoning blocks saves almost nothing (bot_01 #3: 190 removed, −7% in total), so the API evidently counts little of it. Inferred from the numbers, not verified.
- Real savings come from dropping whole finished tasks (b3: 25 of 31 blocks removed, two notes, everything recalled) rather than trimming outputs. bot_01's edits kept every request and reply, which is why they saved less.
- About 37k tokens are fixed overhead (system prompt, skill list, tool definitions) and can't be edited.
- An agent should hand over what comes next with `ctx apply --then`, because the request that asked for the compaction is not in the new context.
