# Consolidating an issue

The user's request reads like: "Consolidate the whole subscribed issue, its description and every comment … then delete all the older comments they replace … and mark it done with issue_done." The goal: the description is the **current state**, a few comments hold the **history and results**, nothing is repeated, nothing still open is lost.

## Steps

1. **Back up:** `node scripts/backup-issue.mjs <ref>`. Note the printed path; you will cite it.
2. **Read everything** in the backup: the description and every comment, including your own replies. Collect every decision, result, link and still-open request.
3. **Rewrite the description** as current state:
   - goal (one or two sentences, with "Done:" when it is),
   - source of truth (links: repo, PRs, commits, files, running deployment),
   - decisions (table: decision | value),
   - open items (table: `# | Item | What's left | Status`).
4. **Post the rest** as few self-contained comments, in the open (not collapsed): typically one history timeline (time UTC | what) and one results/test comment. Start each with the `🤖 <tag> ·` prefix, end with the marker (GitHub `<!-- issue-channel:bot -->`; Linear `[//]: # (issue-channel:bot)`). Don't repeat what the description says. Mention the backup path in the history.
5. **Delete** the older comments they replace, the user's and yours, including the consolidation request itself. If new comments arrived after step 1, back up again first.
6. **Mark the request done** with `issue_done` (`comment_ids` = the request). A deleted comment is reported as "gone"; that's expected.
7. Report to the user: backup path, what the description now holds, which comments were posted, how many were deleted, and anything you could not delete.

## GitHub

```sh
gh api -X PATCH repos/OWNER/REPO/issues/N -F body=@desc.md
gh api repos/OWNER/REPO/issues/N/comments -F body=@history.md --jq .id
gh api -X DELETE repos/OWNER/REPO/issues/comments/<id>      # for each old comment id from the backup
```

## Linear

```sh
node scripts/linear.mjs set-description ENG-123 --file desc.md
node scripts/linear.mjs comment ENG-123 --file history.md
node scripts/linear.mjs delete-comment <id> <id> ...           # replies first, then parents
```

If the user wants **one** consolidated Linear issue, put history and results in the description too and post no comments. Without `admin` (app-actor token) the user's comments can't be deleted: say so and list them.
