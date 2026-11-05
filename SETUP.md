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
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=274878032960
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
mise install      # Node 26 + pnpm, pinned in .mise.toml
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

## Two applications: live and dev

Once the bot is in servers you do not control, keep a second application for development. Same code, different token, different bot user — a broken experiment then cannot take the live bot down or steal its session.

| | Live | Dev |
|---|---|---|
| Application | the one already running | a new one in the same Developer Portal account |
| Token file | `.env` — only on the host | `.env.dev` — only on your machine |
| Run | `mise run start` (host service) | `mise run dev` |
| Invite | the link you hand out | your own test server |

Create the dev application the same way as the live one: **Bot → Message Content Intent: on**, then invite it with the same permission set.

### Invite link for the dev app

Replace `<id>` with the dev application's id (the **Application ID** on the General Information page):

```
https://discord.com/oauth2/authorize?client_id=<id>&permissions=274878032960&scope=bot
```

`274878032960` is the same set the live bot uses: View Channel, Send Messages, Send Messages in Threads, Add Reactions, Manage Messages, Embed Links, Attach Files, Read Message History. Threads are separate: without that bit the bot reads a thread but cannot answer in it (`50001 Missing Access`). Drop `8192` (`Manage Messages`) if you want a dev bot that never touches other people's messages.

### Files

```sh
cp .env.dev.example .env.dev     # paste the dev token
chmod 600 .env.dev
mise run dev
```

`.env` and `.env.dev` are both gitignored. `pnpm start` reads `.env`, `pnpm start:dev` reads `.env.dev`; nothing else differs.

## Running it as a service

Manual `mise run start` is fine while you are at the keyboard. For a server, run it under systemd: it starts at boot, restarts on crash, and every line goes to the journal.

**One instance per token.** Discord accepts a second login and silently invalidates the first, so stop the copy on your laptop before starting one elsewhere.

### Deploy

The host runs Node and pnpm through mise, from the repo's `.mise.toml`, so the NixOS config does not pin the bot's runtime. mise comes from home-manager. `.mise.toml` sets `node.compile = false`: on NixOS mise compiles every tool from source by default, and the prebuilt Node runs because the host has nix-ld.

First time, from the machine that holds the repo:

```sh
rsync -az --delete --exclude node_modules --exclude .env ./ bot-host:Project/cleanlink/
scp .env bot-host:Project/cleanlink/.env
ssh bot-host 'chmod 600 ~/Project/cleanlink/.env && cd ~/Project/cleanlink && mise trust && mise install && mise exec -- pnpm install --frozen-lockfile'
```

`mise trust` is needed once: mise does not read settings from a config file it has not been told to trust. Run `mise exec -- node --test` on the host once — it is offline and catches a Node version mismatch before the bot does.

### Unit (`~/.config/systemd/user/cleanlink.service`)

```ini
[Unit]
Description=cleanlink Discord bot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h/Project/cleanlink
ExecStart=/etc/profiles/per-user/<user>/bin/mise exec -- node --env-file-if-exists=.env src/bot.ts
Restart=always
RestartSec=5
SyslogIdentifier=cleanlink
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
```

`mise exec` picks the Node version from `.mise.toml` in `WorkingDirectory`, so a Node upgrade is a change to the repo, not to the unit. `node` reads `.env` itself, so the token is parsed in exactly one place and never appears in a unit file or in `systemctl show`. The file is `600`.

### Enable

```sh
systemctl --user daemon-reload
systemctl --user enable --now cleanlink
loginctl enable-linger "$USER"     # start at boot without logging in; already on for the bot user
```

`enable` gives boot start, `Restart=always` gives crash recovery, and `StartLimitIntervalSec=0` means it never gives up retrying.

### Logs

```sh
journalctl --user -u cleanlink -f            # live
journalctl --user -u cleanlink -n 200        # recent
journalctl --user -u cleanlink -p warning    # warnings and errors only
journalctl --user -u cleanlink --since today
journalctl --user -u cleanlink -o cat        # message text without metadata
```

The journal on this host is persistent (`/var/log/journal` exists), so logs survive a reboot. Every card miss is logged with its reason (`[card] facebook … post refuses embedding`, `[resolve] … failed twice`, `[clean] … failed`), which is what makes "the bot ignored my link" diagnosable without guessing.

### Optional: yt-dlp

Facebook refuses some videos to anonymous requests but not to yt-dlp. Instagram no longer needs it — its own embed payload carries the video URL. If `yt-dlp` is on the service's `PATH`:

- a Facebook video is downloaded and attached (Discord plays the attachment);

Without it, both fall back: the Facebook card keeps its author line, the Instagram post keeps its poster frame. It is optional and not a package dependency.

```sh
command -v yt-dlp || nix profile install nixpkgs#yt-dlp
```

The unit needs to see it:

```ini
Environment="PATH=/etc/profiles/per-user/<user>/bin:/run/current-system/sw/bin:/usr/bin:/bin"
```

### Update

```sh
mise run deploy   # from your machine
```

It runs `mise run test` (type-check and tests) first and stops on any failure. Then it runs `rsync`, `pnpm install --frozen-lockfile` and `systemctl --user restart cleanlink` on `bot-host`.

`rsync --delete` would remove `.env` too, hence the exclude; if you ever lose it, copy it again and `chmod 600`.

### Declarative alternative

If you would rather own the unit in `/etc/nixos/configuration.nix` than in `~/.config/systemd/user`, move it to a system service. That needs root and a `nixos-rebuild switch`, and `node` must come from a root-visible path:

```nix
systemd.services.cleanlink = {
  description = "cleanlink Discord bot";
  wantedBy = [ "multi-user.target" ];
  after = [ "network-online.target" ];
  wants = [ "network-online.target" ];
  serviceConfig = {
    Type = "simple";
    User = "<user>";
    WorkingDirectory = "/home/<user>/Project/cleanlink";
    ExecStart = "${pkgs.nodejs_26}/bin/node --env-file-if-exists=.env src/bot.ts";
    Restart = "always";
    RestartSec = 5;
    SyslogIdentifier = "cleanlink";
    NoNewPrivileges = true;
    PrivateTmp = true;
  };
};
```

Then `journalctl -u cleanlink` without `--user`. Do not run both units at once.
