---
name: live-context
description: Edit your own working context as a file and continue with the edited version (live context, as in pi-clm). Use when asked to compact, CLM-compact, tidy or shrink your context, when the context is getting long, or when large tool outputs and old exploration should be replaced by short summaries.
---

# Live context

Your working context can be edited as a file. Whatever you leave in that file is what you will work with after the switch, so treat it as bookkeeping: keep what the work needs, shorten what you have already digested.

```sh
ctx() { node ~/.claude/skills/live-context/scripts/ctx.mjs "$@"; }   # a function works in bash and zsh
ctx open     # writes the context file, prints its path and size
ctx list     # block headers only: ids, kinds, tokens
#   … edit the file in place …
ctx apply    # checks the edit, then switches to it when this turn ends
```

## Rules

1. **Do not print or `cat` the whole file.** Its contents are already in your context. Use `ctx list` for block ids, and read single blocks only when you need them.
2. Make one batched edit, with a small script (for example Python `re.sub` on a block's body), and keep the header line of every block you keep.
3. **Edit surgically.** Keep message order and structure, leave unrelated blocks alone, shorten stale bodies in place, and remove only blocks that are clearly obsolete.
4. **Keep conversational units.** If a request is still relevant, keep its answer, or replace the answer with a short, specific summary in the same place. Don't keep requests while deleting all their answers, or the reverse: `apply` warns about both.
5. Remove or shorten raw tool output first, once you have taken the facts from it. A shortened output is marked as trimmed.
6. Keep decisions, constraints, open questions, file paths, commands still needed, test results, where conclusions came from, and the next action.
7. Reasoning blocks (`kind=thinking`) are placeholders: keep or delete them, never edit them. Keep them unless the span around them goes.
8. Add a note with a `[[NOTE]]` line followed by its text, preferably between turns. Replacing everything with one note is allowed when asked for, but it loses everything else.
9. Never invent content in a summary. When unsure, keep the exact text.
10. **Hand over what comes next.** The turn doing the edit is never part of the file, so after the switch you won't see the request that asked for it. Pass anything still to do as `ctx apply --then "<what to do next>"` (for example the user's "after the switch, answer …"), and put results of this turn that must survive in a `[[NOTE]]` at the end.
11. After `ctx apply`, end the turn. The switch happens then, and the next turn starts from the edited context and the `--then` text.
12. **Report sizes with `ctx report`, never from estimates.** After the switch, run `ctx report`: it reads the API's own usage for the old session's last request and the new session's first one, and prints a table (before, after, change, edit counts, switch time). Paste that table unchanged. `--then` already asks for it; `ctx report --from <old id>` works if the temp files are gone.

`apply` refuses a file that no longer matches the conversation (run `open` again), an edited reasoning block, or an unknown block id. The current turn (the one doing the edit) is never part of the file.
