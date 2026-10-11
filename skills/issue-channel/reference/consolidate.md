# Consolidating an issue

The user's request reads like "consolidate this issue". **The repo is the source of truth; the issue is a working surface** ([D14](../../../docs/DECISIONS.md#d14-the-repo-is-the-source-of-truth-issues-are-disposable-working-surfaces)). So consolidating means moving anything durable into the repo first, then shrinking the issue to links plus the work in progress. Nothing still open may be lost.

## Steps

1. **Back up:** `node scripts/backup-issue.mjs <ref>`. Note the printed path; you will cite it.
2. **Read everything** in the backup: the description and every comment, including your own replies. Collect every decision, result, link and still-open request.
3. **Move the durable parts into the repo**, as one PR (in a git worktree if the checkout is shared):
   - decisions → `docs/DECISIONS.md`, numbered and dated, with the why and the PR,
   - measured results → next to the code they test (e.g. `session-fork/RESULTS.md`),
   - open items → `BACKLOG.md`, one heading per item with a stable id,
   - how-tos → the READMEs; design rationale → `DESIGN.md`.
   History is not copied: `git log`, the PRs and the backup cover it. If the user hasn't asked for this yet, propose the mapping first (the "Propose issue to repo" prompt in `PROMPTS.md`) and wait for their go.
4. **After the PR is merged, rewrite the description** as: topic and agent (one or two lines), links to the repo docs, the request being worked on, and the backlog ids this issue covers. No decision, result or open item lives only in the issue.
5. **Post at most one short comment**, in the open: what moved where, the PR link, and the backup path. Start with the `🤖 <tag> ·` prefix and end with the marker (GitHub `<!-- issue-channel:bot -->`; Linear `[//]: # (issue-channel:bot)`). Times are HKT.
6. **Delete** the older comments, the user's and yours, including the consolidation request itself. If new comments arrived after step 1, back up again first.
7. **Mark the request done** with `issue_done` (`comment_ids` = the request). A deleted comment is reported as "gone"; that's expected.
8. Report to the user: backup path, the PR, what the description now holds, which comment was posted, how many were deleted, and anything you could not delete.

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

If the user explicitly wants the issue to stand alone (no repo), put history and results in the description and post no comments. Without `admin` (app-actor token) the user's comments can't be deleted: say so and list them.
