# issue-channel prompts

Usage: type your topic or task, then paste one of these prompts after it. Run them in a Claude Code session started with `clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`.

## Start: create an issue and listen to it

```text
Create a new issue in iamwrm/mainbot for the topic above, subscribe to it with issuechan, check that the subscription is listed and the server health check passes (tell me to reconnect issuechan via /mcp if its tools are missing), then post a short welcome reply and give me the link.
```

## Start: listen to an existing issue

```text
Subscribe with issuechan to the GitHub issue mentioned above, confirm it is listed, and post a short reply on it saying you are listening.
```

## Live status comment

```text
While working on the task above, post one status comment on the subscribed issue with a headline and a Step/Status/Notes table, keep editing that same comment in place with gh as each step progresses (always keeping the bot marker as the last line), and post a final summary with issue_reply when everything is done.
```

## Consolidate the conversation

```text
Rewrite the whole subscribed issue conversation into as few self-contained comments as you judge best, in whatever structure fits the content, keeping every decision, result, link and still-open request, post them with issue_reply, then delete all the older comments they replace, both mine and yours.
```

## Wrap up

```text
Post a final summary on the subscribed issue, close it, and unsubscribe from it.
```
