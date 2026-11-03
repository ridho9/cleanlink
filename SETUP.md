# Setup: from zero to a running bot

Follow this in order. At the end you will have a bot that replies to DMs with clean links, and `mise run start` is the only command you need from then on.

You need: a Discord account, a server you can add bots to (it can be an empty one you make), and this repo cloned.

---

## 1. Create the application

1. Open <https://discord.com/developers/applications>.
2. **New Application** → give it a name (this becomes the bot's name; you can rename it later) → agree to the terms → **Create**.
3. You land on **General Information**. Copy the **Application ID** — a long number. You need it for the invite link in step 4.

Nothing else on this page matters for now.

## 2. Get the token

1. Left sidebar → **Bot**.
2. Under **Token**, press **Reset Token** → **Yes, do it**.
3. **Copy it now.** Discord shows it once. If you lose it, reset again; there is no "view token".

Treat it like a password — it is full control of the bot. Never paste it into a chat, a commit, or an issue. `.env` is already gitignored.

## 3. Turn on Message Content

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable:

- ✅ **Message Content Intent**

This one is not optional. Without it the bot connects fine, receives your DMs, sees empty text, and replies to nothing — with no error anywhere. It is the single most common reason a DM bot looks dead.

`Presence` and `Server Members` are not needed. Applications under 100 servers can toggle this freely; above 100, Discord requires verification.

## 4. Invite it to a server

Discord only lets you DM a bot that shares a server with you, so this step is required even though the bot never posts in servers.

1. Left sidebar → **OAuth2** → **URL Generator**.
2. Scopes: ✅ **bot**.
3. Bot Permissions: leave **everything unchecked** — it needs none.
4. Copy the **Generated URL** at the bottom and open it in your browser.

   Or build it by hand:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=0
   ```

5. Pick your server → **Continue** → **Authorize**.

The bot now shows in your member list as offline. That is expected until step 6.

## 5. Put the token in `.env`

From the repo root:

```sh
cp .env.example .env
```

Open `.env` and put the token directly after the `=`:

```
DISCORD_TOKEN=<your-bot-token>
```

No quotes, no spaces, no `Bearer`, one line. If the token has spaces in it, you copied line breaks — reset it and copy again.

## 6. Install and start

```sh
mise install      # Node 24 + pnpm, pinned in .mise.toml
pnpm install
mise run start    # or: pnpm start
```

A healthy start looks like:

```
logged in as cleanlink#1234
DM the bot a link to get the clean one back.
```

Leave that terminal open; the bot runs while it does. `Ctrl+C` stops it.

## 7. Verify

**Test 1 — the plumbing (no network needed).** In Discord, DM the bot:

```
https://youtu.be/dQw4w9WgXcQ?si=abc123
```

It should reply `https://youtu.be/dQw4w9WgXcQ`. This link only needs parameter stripping, so if this works, the Gateway, the intents, the DM filter and the reply all work.

**Test 2 — the redirect resolver.** Send a Threads share link:

```
https://www.threads.com/share/BAbCdEfGhI
```

It should reply `https://www.threads.com/@phodhipo/post/DfPOscPD6UR` after a short pause (~0.5 s, one network round trip). Share codes do expire, so if this one is dead, send a fresh share link from your own Threads app instead.

**Test 3 — silence.** Send something it should ignore, e.g. `hello`. No reply. Send an already-clean link, e.g. `https://youtu.be/dQw4w9WgXcQ`. No reply. Silence is correct when nothing changed.

Every cleaned link also prints a line in the terminal:

```
cleaned https://youtu.be/dQw4w9WgXcQ?si=abc123 -> https://youtu.be/dQw4w9WgXcQ
```

If the reply appears in Discord, you are done. That terminal is now the bot.

---

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `DISCORD_TOKEN is not set...` and exit | No `.env`, or it is not in the repo root | `cp .env.example .env`, fill it in, run from the repo root |
| `.env not found. Continuing without it.` | Same as above — the bot then exits with the message above | Create `.env` |
| `Error [TokenInvalid]: An invalid token was provided.` | Wrong, revoked, or mangled token (quotes, spaces, line break) | **Reset Token** and paste it raw and alone |
| `Error [DisallowedIntents]: Privileged intent provided is not enabled or whitelisted.` | Message Content Intent is off | Enable it (step 3), wait a minute, restart |
| `logged in as ...` but no reply at all | Message Content Intent off, or you are not DMing the bot, or the link needed no change | Check the terminal for a `cleaned ...` line: present means the reply failed, absent means it never got text |
| No reply from a site you expect | That site is not in the rule table — Reddit, Spotify and Google were deliberately removed | See [README](README.md) → Supported sites |
| Reply is a bare site homepage | A shortener that no longer accepts the code | Send a fresh share link; the guard should return silence instead |

## Restarting and keeping it alive

Manual is fine: `mise run start` whenever you want it up.

To have it start at login and restart on crash, a `launchd` agent in `~/Library/LaunchAgents/` is the macOS-native answer — ask and it can be generated for this machine. Note that it will then run whenever the Mac is on; nothing else in this setup changes.
