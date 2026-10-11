# User-requested Pi exit with Herdr

Use this when the user wants to wrap up and exit a Pi TUI with **Herdr CLI + Ctrl-D**, without modifying Pi upstream or adding a shutdown extension. Do not exit merely because a task is finished.

## Before arming exit

1. Finish the requested work. Close only a work issue the user explicitly asked to close, verify its new state, and leave home inboxes open.
2. Await the final `issue_reply` on the originating issue/thread, using the exact request's `comment_ids`. Do not complete other outstanding requests. Save continuity notes and the persisted session path if recovery is needed.
3. Confirm `test "${HERDR_ENV:-}" = 1`. If it fails, do not inspect/control a focused Herdr session from outside Herdr; leave Pi running and ask the user to exit manually.
4. Read the installed Herdr skill (`herdr --skill`) and relevant CLI help. Discover the calling pane with `herdr pane current`, or find the requested target with `herdr agent list`; do not guess a pane from focus or sidebar order. Record the resolved pane ID as `PANE` for post-exit inspection.
5. Prefer a unique live agent name as `TARGET`. Inspect `herdr agent get "$TARGET"` and `herdr agent read "$TARGET" --source detection --lines 40`. Confirm it is the intended **Pi**, at its **main editor**, with an **empty editor**, no dialog/menu, and no knowingly queued work. Ctrl-D has other meanings in dialogs (including session deletion); with a nonempty editor it edits text instead of exiting. Never clear a user's draft automatically.
6. Do not reuse/reassign the target name or submit more work after arming. If the target, UI, or pending work cannot be verified, leave Pi running. External state observation cannot make concurrent new input atomic.

## Controller in another pane

From a separate controller, after those checks:

```sh
herdr agent wait "$TARGET" --until idle --until done --timeout 120000 &&
herdr agent send-keys "$TARGET" ctrl+d
```

Use the **agent** surface so a missing agent is rejected instead of sending Ctrl-D to an unrelated shell. Explicit `idle`/`done` excludes `blocked`, which Herdr's default settled-state wait also accepts. A timeout, unknown/blocked state, or missing target must fail closed: leave Pi running, inspect the result, and ask the user. Do not retry blindly or fall back to `kill`, SIGTERM, or pane/session/server closure.

For an already-running target, the wait follows its state rather than a particular request. Make sure final replies/writes have landed and no newer request needs answering. Check the target again if work or identity changes while waiting.

## Exiting yourself: detach the controller

An attached tool waiting for **its own Pi** to become idle prevents that Pi from finishing. Instead launch a detached helper as the **last tool action** of the turn, then return the final terminal answer promptly. Do not await the helper from the target Pi.

Linux example, with the verified unique agent name substituted (not a literal placeholder):

```sh
test "${HERDR_ENV:-}" = 1 || exit 1
TARGET='verified-unique-pi-name'
LOG=$(mktemp /tmp/pi-exit.XXXXXX.log)
setsid nohup bash -c '
  target=$1
  herdr agent wait "$target" --until idle --until done --timeout 120000 &&
    herdr agent send-keys "$target" ctrl+d
' pi-exit "$TARGET" >"$LOG" 2>&1 </dev/null &
helper_pid=$!
printf 'Exit helper armed: pid=%s log=%s\n' "$helper_pid" "$LOG"
```

All helper input/output is detached so the tool can return. No arbitrary sleep is needed: actual idle/done is the barrier. If `setsid`, `nohup`, or the relevant Herdr commands are unavailable, use a separate controller rather than inventing an unverified replacement. Do not arm an automatic model-resume notification for this helper.

If launching commands through `herdr pane run`, pass the **complete shell command text as one correctly quoted argument**. It types text plus Enter, not an argv-preserving process launch; do not assume separate `sh -c` arguments retain their quoting.

## Verify and recover

- The target agent may report **armed**, not **exited**, before it shuts down. A successful wait, key-send acknowledgement, or helper launch alone does not prove exit.
- From the controller, read the helper log and inspect the recorded pane with `herdr pane process-info --pane "$PANE"` and `herdr pane read "$PANE" --source recent-unwrapped --lines 80`. Confirm the foreground returned to that pane's shell. Never send a second Ctrl-D to the returned shell.
- Check captured output for boundary/stale-context diagnostics. In a controlled test, capture the Pi exit status and verify completed assistant messages are in its session JSONL; do not claim persistence based on a screenshot alone.
- Clean up only helper/test panes you created, after their work has stopped. Preserve logs/session artifacts. Never close someone else's pane or the Herdr server.
- Exit is not restart. For recovery, explicitly resume the saved Pi session (`pi --session <path-or-id>`). Its durable issue subscriptions restore; a fresh session/fork does not take them over. Do not run Claude's `spawn/restart-agent.sh` or session-fork tooling on a Pi log. See [Pi lifecycle and recovery](../../../adapters/pi/README.md).

## Evidence and limits

Verified on Linux with Pi **1.1.0**, Herdr **0.9.3**, and the normal configured extensions, including last-turn/quiz and CLM:

| Test | Result |
| --- | --- |
| Fresh idle TUI, empty editor, Herdr Ctrl-D | Exit 0, returned to shell |
| Completed real response in regular TUI, then wait and Ctrl-D | Exit 0, assistant persisted |
| Fullscreen TUI, prompt-and-wait followed immediately by Ctrl-D | Exit 0, assistant persisted |
| Nonempty-editor control | Pi remained running; draft was not cleared |

No boundary/stale-context errors were observed in captured output. [Research and test record](https://github.com/iamwrm/mainbot/issues/45#issuecomment-6106166447).

These are controlled **idle-exit** results, not a guarantee for active inference, concurrent input, retries, slow settled handlers, other platforms, or changed keybindings. Do not send Ctrl-D during active inference. Killing an active Pi can dispose its extension runtime before pending inference finishes, producing missing persisted assistant IDs and stale-context diagnostics; a fixed delay does not repair that lifecycle ordering.
