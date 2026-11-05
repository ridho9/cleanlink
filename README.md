# cleanlink

A Discord bot that strips trackers from share links. You DM it a link, it replies with the clean one. That's the whole product.

It exists because the newer share formats (`threads.com/share/<code>`, `vm.tiktok.com/<code>`, …) hide the real target behind an opaque code. Only the server knows the mapping, so the bot resolves the redirect once and hands back the canonical URL without the tracking parameters.

## Requirements

Node 24 and pnpm are pinned in [.mise.toml](.mise.toml), so [mise](https://mise.jdx.dev) handles both:

```sh
mise install
pnpm install
```

## Setup

**See [SETUP.md](SETUP.md) for the full walkthrough** — invite link, the exact portal toggles, verification steps and a troubleshooting table.

Short version:

1. Create an application at <https://discord.com/developers/applications>.
2. **Bot → Privileged Gateway Intents → Message Content Intent: on.** Without this the bot receives DMs with empty content and silently does nothing.
3. **OAuth2 → URL Generator**: scope `bot`, permissions `274878032960` — View Channel, Send Messages, **Send Messages in Threads**, Add Reactions, Manage Messages, Embed Links, Attach Files, Read Message History. Invite it to any server you are in (that is how Discord lets you DM a bot). Without *Send Messages in Threads* the bot can read a thread but not answer in it, which Discord reports as `Missing Access`.
4. Copy the token:

   ```sh
   cp .env.example .env      # then paste the token into .env
   ```

5. Run it:

   ```sh
   mise run start            # or: pnpm start
   ```

Leave it without a token and it exits with a message rather than a stack trace.

## Usage

DM the bot:

```
https://www.threads.com/share/BAbCdEfGhI
```

It replies:

```
https://www.threads.com/@phodhipo/post/DfPOscPD6UR
```

Behaviour:

- **DMs and server channels.** In a DM it just replies. In a server channel it also removes the preview card from your message, if it has been given `Manage Messages`.
- **The 👀 reaction only appears on messages it can act on.** A link no rule owns, or a message with no link, gets no reaction and no reply — the check is a regex pass, so nothing is fetched to find out.
- **`nh/<id>` stands in for an nhentai link.** Send `nh/693549` and the bot replies with the real gallery link plus the card. Any case works (`NH/693549`), a leading zero is dropped, and a `/nh/<digits>` path inside some other URL is **not** treated as a shorthand.
- **Silent unless it changed something.** Links it does not handle, links with nothing to strip, and failed lookups all get no reply. A link that gets a card is an exception: it is answered even when it had nothing to strip, because the card itself is the reply.
- **Never edits or deletes text.** The only write to another message is Discord's embed-suppression flag in a server channel; the content is never touched.
- One reply per message, up to 5 links, one per line, and a card for each carded link in the message.

Server mode needs the bot's role to have **Manage Messages** (Server Settings → Roles, or a per-channel override). Without it the bot still replies, it just cannot clear the original card:

```
[guild] no Manage Messages — original embed left in place
```

Note that server mode means the bot reads message content in every channel it can see. If that is more access than you want, give it `Manage Messages` on one channel only and deny it `View Channel` everywhere else.

## Supported sites

| Site | Handles | Card |
|---|---|---|
| Threads | `/share/<code>` share links, strips `xmt`, `slof` | **yes** — post text, author, image from the page's OpenGraph tags |
| Instagram | `/share/…` links, strips `igsh`, `igshid`, `mdxt`, `psln` | **yes** — one embed per image, for photos, carousels and reels; a reel gets its still, not the video |
| TikTok | `vm.` / `vt.` short links, strips `is_from_webapp`, `sender_device`, `web_id`, `_t`, … | **yes** — caption, author, cover, counts from `tikwm.com` |
| Twitter / X | strips `s`, `t`, `ref_src`, `ref_url` | **yes** — text, avatar, stats, quote, still |
| YouTube | on `watch` links keeps only `v`, so playlist and radio parameters go; short links lose `si`, `feature` | no, the native player is better |
| Facebook | `fb.watch`, `/share/…`, strips `rdid`, `refid`, `sfnsn`, `__tn__`, `share_url` | **yes** — author, text and media from the public embed iframe, or from a mirror when the post refuses it |
| Pixiv | nothing to strip | **yes** — the artwork pages, re-uploaded |
| nhentai | nothing to strip; `nh/<id>` shorthand works as input, in any case | **yes** — title, author, and the cover attached behind Discord's spoiler flag |
| Misskey | nothing to strip | no, Discord's own preview is complete |

Common trackers (`utm_*`, `fbclid`, `gclid`, `twclid`, `yclid`, `mibextid`, `_ga`, `_gl`) are stripped everywhere.

Reddit, Spotify and Google were removed on purpose: only fake share codes had ever been tried against them, so they sat in the table as untested. Add them back from [src/rules.js](src/rules.js) once a real link from each has been checked.

## Preview cards

Seven sites get a card the bot builds itself, because Discord's own preview fails on each of them. Every card comes from the site's own data — no third-party renderer is used anywhere.

| Site | Source | What the card shows |
|---|---|---|
| **X** | `api.fxtwitter.com`, `video.twimg.com` | full text, avatar, quote as a blockquote, Replies/Retweets/Likes/Views, one full-size embed per image (the quoted tweet's pictures included), and the video or GIF attached as `video.mp4` — Discord cannot play X video inside an embed, but it plays an attached file. X offers several renditions; the bot takes the **largest that fits the 8 MB budget**, and the poster frame appears only when nothing could be attached, so the player is not shown twice |
| **Pixiv** | `ajax/illust` + `ajax/illust/<id>/pages` | title, author, tags, up to 5 pages downloaded with a pixiv `Referer` and re-uploaded, because `i.pximg.net` answers `403` without it and Discord never sends one |
| **Threads** | the page's OpenGraph tags, fetched as `Mozilla/5.0` | author, post text, image or avatar. Crawled as `Discordbot` the page returns a 107 KB shell with no description, which is why Discord's own Threads card has no words |
| **Instagram** | page + `api/v1/oembed` + `/p/<shortcode>/embed/captioned/` | display name, the **full** caption, Likes/Comments, one embed per carousel image. Reels are carded like photos: the clean frame, not the video |
| **Facebook** | `plugins/post.php`, `yt-dlp` for video, and `facebed.com` for what both refuse | author, post text, media, and the video attached when it can be had; a reel too large to attach is sent as the `facebed.com` page link instead, which Discord unfurls into a player with the caption |
| **TikTok** | `tikwm.com/api` | caption, author, avatar, Plays/Likes/Comments, and the video attached from TikTok's own CDN. Its own oEmbed returns an iframe only, and the page's `og:title` is the literal `TikTok · TikTok` |
| **nhentai** | `api/v2/galleries/<id>` | title, author, and the cover attached as `SPOILER_cover.webp`. The gallery page is a Cloudflare challenge, but the API is not. `NH/693549` and `nh/693549` both work as shorthand |

Why the other two get no card: **Misskey** already answers Discord's crawler with complete OpenGraph tags, and its URL was confirmed to unfurl; **YouTube** has a native player.

### Limits that shape every card

- **One embed per image.** A Discord embed has one `image` and one `thumbnail` field — no gallery — so two full-size images need two embeds. The second image is never put in `thumbnail`; a shrunk version was rejected.
- **An embed suppresses link unfurls.** A message holding our card never creates Discord's own preview, and an MP4 in `embed.video` is dropped outright. That is why a video can only arrive as an attachment or as its own message.
- **When nothing fits the upload budget, the media URL goes out as a second message.** Discord unfurls a bare video URL into a player with no upload and no size limit; it just has to be alone in its message. At most two such follow-ups per reply, one per card, and the card then omits the poster frame so the player is not shown twice.
- **No spoiler for embed images.** Only an attachment honours the `SPOILER_` filename prefix, which is why the nhentai cover leaves the embed. A spoiler is redaction, not permission.
- **Budgets per message, shared by every card:** 5 cards, 10 embeds, 10 files, 8 MB of attachments. A card that would break a budget is skipped whole.
- **A card is decoration and degrades:** a rejected attachment resends the embeds alone, a missing **Embed Links** permission resends the plain links. Never an error, never a lost clean link.
- **Card text is third-party text:** everything passes through `escapeMarkdown`, and composition happens before clipping so our own `> **Quoting …**` markup survives.

Adding a card is a table entry in [src/cards/index.js](src/cards/index.js) plus a builder module beside it.

## What has actually been verified

Query-parameter stripping is deterministic and covered by tests for every site. Resolving the opaque share links is the fragile part, so here is what was checked against the live networks rather than a stub:

| Site | Param strip | Share resolve | Card |
|---|---|---|---|
| Threads | live | **real code** — `302` → clean post URL | n/a |
| Instagram | live (`mdxt`, `psln`) | `/share/` still fake: `200`, no redirect → silence | n/a |
| TikTok | live | **real code** — `vt.tiktok.com` → `/@user/video/<id>` | n/a |
| Facebook | live (`share_url`) | **real code** — `/share/<code>` → `/posts/<id>` | n/a |
| Twitter / X | live | n/a | **real code** — built from `api.fxtwitter.com`, sent to Discord and read back |
| YouTube | live | n/a | n/a |
| TikTok | live | **real code** — `vt.tiktok.com` → `/@user/video/<id>` | **real code** — `tikwm.com` answered for a real video, card sent and read back |
| Threads | live | **real code** — `302` → clean post URL | **real code** — text, author and avatar from the page, card sent and read back |
| Instagram | live (`mdxt`, `psln`, `srtk`) | `/share/` still fake: `200`, no redirect → silence | **real code** — single post, 4- and 10-image carousels and a reel all read back from Discord |
| Facebook | live | **real code** — `/share/<code>` → `/posts/<id>`, `/reel/<id>` | **real code** — text, author and image from `plugins/post.php` for a post, a reel and a watch link; cards sent and read back |
| nhentai | n/a | n/a | **real code** — `api/v2/galleries/<id>` and a `t.nhentai.net` cover that Discord can fetch; card built and inspected, gated on NSFW |
| Pixiv | n/a | n/a | **real code** — 2 pages fetched with a pixiv `Referer`, uploaded, embed rendered |

Four of the six tracker sites have resolved a real share link, and every cleaned URL was re-fetched to confirm it still serves the post. Both cards were posted to a real channel and read back, attachment and embed intact. If a site silently does nothing, this table is the first place to look.

## Adding a site

Everything site-specific is data in [src/rules.js](src/rules.js):

```js
{
  id: 'example',
  hosts: ['example.com'],            // subdomains match automatically
  share: /^\/share\//i,              // optional: path that needs resolving first
  shorten: ['ex.co'],                // optional: hosts that only ever redirect
  drop: [/^trk$/i],                  // query params to remove
  keepOnly: { path: /^\/watch$/, keep: [/^v$/i] },  // optional: keep only these params
  ua: 'Mozilla/5.0',                 // optional: user agent override
  failure: [/example\.com\/error/],  // optional: resolved URLs meaning "bad code"
}
```

The engine ([src/clean.js](src/clean.js)) needs no changes. Add a case to [test/clean.test.js](test/clean.test.js) with a stubbed `fetch`, then try one real link by hand.

## Tests

```sh
mise run test        # or: pnpm test
```

The cleaning logic is plain functions with `fetch` injected, so the whole suite runs offline in under 100 ms with no Discord token.

## Notes and limits

- **Resolution costs one request, and that request is a "click."** The bot fetches the share URL once from its own IP, with no cookies and no account, to learn the target. The platform still records one share-open — it just is not you, and the link you forward no longer carries the tracker. There is no way around this: the mapping exists only server-side.
- **The default user agent is the bare `Mozilla/5.0`, and that is deliberate.** The request exists to collect a `3xx`, and platforms that sniff for a real browser answer a browser string with their JavaScript shell (`200`, no redirect, no OpenGraph tags) instead. Evidence: Threads returns `302` to `Mozilla/5.0` and `200` to a Chrome UA; Facebook `/share/` returns `302` vs `400`; `fb.watch` returns `400` to a Chrome UA. A rule can still override it with `ua` if a site refuses anything but a browser.
- **New share tokens keep appearing.** `mdxt` and `psln` on Instagram, `_t` on TikTok, `share_url` on Facebook — none of these existed in the first version of the rules and all were found by running real links from a real server. That is the maintenance cost of this bot, and it is one regex per token.
- **Shorteners do not report bad codes as errors.** They redirect to their front page or a parent path, so a naive resolver hands back a useless link and looks broken. The engine rejects a target that is the site root or a path prefix of the original, plus any per-site `failure` pattern:
  - `fb.watch/<bad>` → `facebook.com/watch/`
  - `vm.tiktok.com/<bad>` → `tiktok.com/?_r=1`

  Rejected by a generic rule (redirect landed on the site root, or the target path is a prefix of the original) plus per-site `failure` patterns where the shape is not generic.
- **Only allowlisted hosts are ever fetched.** A hop is followed only while the current URL is a share/shortener URL belonging to a rule. Redirect targets outside the rule table are returned but never requested, which is what keeps this SSRF-safe.
- **A thread needs its own permission.** `Send Messages` does not cover threads; without *Send Messages in Threads* the reply fails with `50001 Missing Access`, and the bot now logs that, gives the original preview back and stays quiet instead of reporting a gateway error.
- **The bot cannot remove an embed from your message in a DM.** Suppressing embeds on a message you did not author needs `Manage Messages`, and DM channels have no permissions, so Discord answers `404` (verified). Wrap the link in angle brackets — `<https://…>` — and Discord shows no preview on your message; the bot still parses it and its own reply carries the preview.
- Nothing is stored: no database, no cache, no message logging beyond the one `console.log` per cleaned link.
- Limits: 4 s per hop, 3 hops, 5 links per message. A failed lookup leaves the link untouched rather than guessing.
- Card limits, shared by every card in the message: 10 embeds, 10 attachments, 5 Pixiv pages per work, 8 MB of attachments, 6 s per request. A card that does not fit the budget is skipped whole, and a card that cannot be built leaves the plain cleaned reply — never an error.
