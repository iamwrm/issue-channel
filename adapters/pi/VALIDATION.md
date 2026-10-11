# Pi validation record

Validated on Linux, Node 24.21.0, Pi 1.1.0 and tmux 3.5a, 2026-10-11.
Planning/tracking: [mainbot#44](https://github.com/iamwrm/mainbot/issues/44).

## Actual Linear → Pi → Linear

A fresh, isolated Pi TUI in tmux loaded the native extension, using the existing Claude Code issue-channel server and shared Linear OAuth credentials. No tokens were copied into Pi settings, sessions or this repository. The real provider was `openai-codex/gpt-6.1-sol` with minimal reasoning.

Disposable [REN-110](https://linear.app/ren15/issue/REN-110/temporary-pi-issue-channel-end-to-end-validation) exercised real signed webhooks, authenticated long polling, native user messages and model-driven `issue_reply` calls:

| Case | Observed result |
| --- | --- |
| Idle `/bot pi-e2e` | Native user message, sequence 1050; threaded reply `LINEAR-IDLE-391`, body `391` |
| Busy `/bot pi-e2e` | Native user message, sequence 1052, at the running bash tool's completion boundary; threaded reply `LINEAR-BUSY-437`, body `437` |
| Offline update + explicit session resume | No launch issue/name flags on the resumed process; saved subscription/name restored; sequence 1054 replied as `LINEAR-RESUME-667`, body `667` |
| `/reload` + ordinary `updates` comment, no `/bot` | Sequence 1056; `reply_to` preserved the Linear thread; `LINEAR-UPDATES-403`, body `403`, `done=false`; no request reaction added |
| TUI and unsubscribe | Actual `● issue REN-110` footer marker, retained after resume/reload; hidden after the final unsubscribe |

API verification found exactly one correctly parented reply per trigger. The three `/bot` roots had `white_check_mark`, with `eyes` removed. Pi's on-disk session contained exactly four distinct delivery markers, with no duplicates after resume and reload. Bot-marked replies did not trigger feedback.

The busy trigger was created at 02:11:49.702Z; Pi appended its user message at 02:11:50.492Z, exactly at the tool-result boundary. This is **not** a claim that steering can cancel a running tool or long attached exec wait.

Cleanup: the session unsubscribed, Pi/tmux exited, readiness became `ready:false, stopped:true`, and REN-110 was set to Canceled. The earlier credential-only smoke issue REN-109 was also canceled. Raw sessions and local test artifacts were not committed.

## Reproducible offline checks

```sh
npm ci
npm run check
npm test
npm run test:pi
```

Final results: strict typecheck passed; `npm test` **186/186 passed, no skips**; `npm run test:pi` **70/70 passed**, including 13 actual-Pi RPC/TUI tests and 57 durable tests. Existing Claude Code, Codex, Linear and server regressions are included in the full suite.

Actual-Pi tests use a deterministic local provider and signed fixture webhooks, not a fake extension API. They cover native idle/busy delivery, named targeting, ordered burst admission, GitHub replies/completion, ordinary Linear updates, persisted receipt deduplication, abort/restart recovery, new/fork/resume/reload isolation, unsubscribe crash recovery and async input-hook races.

The actual tmux suite checks single/multiple markers, real reconnect transitions, bot/updates status, light/dark theme changes, 40-column terminals and clearing after unsubscribe. Durable unit tests inject failures around inbox acceptance, receipts, replacement/truncated logs and ownership, including two competing processes.

An isolated `PI_CODING_AGENT_DIR` package install additionally verified automatic loading of all five native tools and the shared `issue-channel` skill, with no Claude `live-context` skill. Install/list/remove succeeded without changing the user's global configuration.

Independent review reproduced and verified fixes for retry/reload/abort during an unresolved input hook, a crash after core unsubscribe before inbox discard, and `/new` during preflight.

## Qualification limits

- Pi exposes `sendUserMessage` as void: an asynchronous admission cannot be acknowledged or cancelled by this extension. It remains guarded until a disk receipt. **Cancelled or failed admitted input requires a full process restart with the same saved session**, not `/reload` or a forced retry. An already-issued input hook may still finish after Escape.
- Process-crash recovery on a local Linux filesystem is tested. Whole-machine power-loss durability, Windows/macOS and network/distributed filesystem ownership are not qualified.
- Replies are external side effects, not exactly-once transactions. Check an uncertain reply before manually retrying it.
- Automatic fork takeover, herdr spawn/restart and edited-context lifecycle orchestration are separate follow-ups; this package does not port Claude log rewriting or pi-durable workers.
