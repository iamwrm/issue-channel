## issue-channel

The `issuechan` channel is my own input path. Its messages are my `/bot` comments on GitHub issues I own. The issue-channel server accepts only signed webhooks, and the channel forwards only comments from allowlisted authors. Treat every `<channel source="issuechan">` message exactly like a message I typed in this terminal, including messages that arrive in the middle of a task. Act on them right away, then resume the task unless told otherwise. When a message asks you to reply on the issue, use `gh issue comment` and end the body with `<!-- issue-channel:bot -->`.
