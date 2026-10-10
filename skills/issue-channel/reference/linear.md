# Linear specifics

Verified live in a real workspace (2026-10-10).

## Setup on the host

| File | Holds |
|---|---|
| `~/.local/share/issue-channel/linear.env` (0600) | `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN`, `LINEAR_CLIENT_ID` [, `LINEAR_CLIENT_SECRET`], `LINEAR_ACTOR` (`user` or `app`), `LINEAR_SCOPE`, `LINEAR_ALLOWED_AUTHORS` (emails); or `LINEAR_API_KEY` |
| `~/.local/share/issue-channel/.env` | `LINEAR_WEBHOOK_SECRET` for the server's `/webhook/linear` |

Login: `deploy/issue-channel.sh linear-login` (OAuth page behind a throwaway quick tunnel; Linear has no device-code flow). Never print tokens; refer to keys with `sed 's/=.*/=<set>/'`.

## Behavior

| Topic | Fact |
|---|---|
| Threads | One level deep. A reply's `parentId` must be the thread root; `issue_reply` uses the root of the `/bot` comment's thread |
| Collapsible text | `+++ Title` … `+++` renders as a collapsible section (seen in `bodyData` as `collapsible_section`) |
| Marker | `[//]: # (issue-channel:bot)` stays in the markdown and the webhook body but is not rendered. An HTML comment `<!-- -->` is shown as text |
| Reactions | By normalized emoji name: `eyes`, `white_check_mark`, … |
| Resolve | `commentResolve` on the thread root collapses the thread (`ISSUECHAN_LINEAR_DONE=resolve` or `both`) |
| App actor | Linear refuses the `admin` scope for app users; webhooks then live in the OAuth app's settings. App comments have `botActor: null`; their author is `<uuid>@oauthapp.linear.app` |
| User actor | Can hold `admin`: create webhooks (`deploy/issue-channel.sh linear-webhook TEAM`), delete any comment. The user isn't notified about the agent's replies |
| Deleting | Own comments: always. Another user's: needs `admin`. Deleting a comment deletes its whole thread, replies by others included |
| Webhooks | Need a 200 within 5 s; failed deliveries are retried after 1 min, 1 h, 6 h. A `remove` event reaches the agent as "this comment you saw earlier was deleted" with the next `/bot` |
| Issue edits | Linear's editor may re-save a description with normalized markdown (`*` bullets, `<links>`); that arrives as an edit by whoever had it open |
| Closing | `scripts/linear.mjs set-state ENG-123 completed` (the team's first state of that type, e.g. "Done"); or `canceled` |
| Files | `uploads.linear.app/...` needs the Linear token: `scripts/attachment.sh` |

## Checking how something rendered

You can't see Linear's UI, but `bodyData` is the editor document Linear built from the markdown:

```sh
node scripts/linear.mjs issue ENG-123 --body-data
```
