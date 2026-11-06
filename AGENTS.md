# cleanlink

Discord bot that strips trackers from share links and builds preview cards. `README.md` is the full reference.

The bot runs from this checkout on the bot host, named by `BOT_HOST` in the gitignored `mise.local.toml`. Check `hostname` first: on that machine, run commands directly, not over `ssh` (it may have no key for itself). `mise run review` and `mise run deploy` handle both cases.

## Daily review

When the user asks for the daily review:

1. Run `mise run review` (last 24 h from the bot host; `SINCE='…'` for another period).
2. For every kind under **Problems** and every entry under **Errors**, reproduce one example URL from the report on the bot host and name the cause: a fake or expired link, a site change, or a bot bug.
3. Report to the user: totals, then one line per problem kind with its cause and a proposed fix. A day with no problems is a one-line report.

Done when every problem kind and error has a cause. Fixes are proposals only: the user approves every commit and deploy.
