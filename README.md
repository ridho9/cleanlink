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
3. **OAuth2 → URL Generator**: scope `bot`, permissions `0` — it needs no server permissions. Invite it to any server you are in (that is how Discord lets you DM a bot).
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
- **`nh/<id>` stands in for an nhentai link.** Send `nh/693549` and the bot replies with the real gallery link plus the card.
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
| Instagram | `/share/…` links, strips `igsh`, `igshid`, `mdxt`, `psln` | **yes** — one embed per image for photo posts and carousels; reels and TV posts get a masked `[▶ reel](vxinstagram.com/…)` link so Discord renders a playable video |
| TikTok | `vm.` / `vt.` short links, strips `is_from_webapp`, `sender_device`, `web_id`, `_t`, … | **yes** — caption, author, cover, counts from `tikwm.com` |
| Twitter / X | strips `s`, `t`, `ref_src`, `ref_url` | **yes** — text, avatar, stats, quote, still |
| YouTube | on `watch` links keeps only `v`, so playlist and radio parameters go; short links lose `si`, `feature` | no, the native player is better |
| Facebook | `fb.watch`, `/share/…`, strips `rdid`, `refid`, `sfnsn`, `__tn__`, `share_url` | **yes** — author, text and media from the public embed iframe |
| Pixiv | nothing to strip | **yes** — the artwork pages, re-uploaded |
| nhentai | nothing to strip; `nh/<id>` shorthand works as input | **yes** — title, author, and the cover attached behind Discord's spoiler flag |
| Misskey | nothing to strip | no, Discord's own preview is complete |

Common trackers (`utm_*`, `fbclid`, `gclid`, `twclid`, `yclid`, `mibextid`, `_ga`, `_gl`) are stripped everywhere.

Reddit, Spotify and Google were removed on purpose: only fake share codes had ever been tried against them, so they sat in the table as untested. Add them back from [src/rules.js](src/rules.js) once a real link from each has been checked.

## Preview cards

For X, Pixiv, Threads, Instagram, Facebook, TikTok and nhentai the bot posts its own card, because Discord's own preview fails on all seven:

- **X** — Discord shows a truncated title. The bot reads `api.fxtwitter.com` and builds a card with the full text, the avatar, the reply/retweet/like/view counts, a quoted tweet as a blockquote, and one full-size embed per photo, or the video's poster frame. It never rewrites the host to a fixer domain.
- **Pixiv** — `i.pximg.net` answers `403` unless the request carries a pixiv `Referer`, and Discord never sends one, so the native card has no image. The bot downloads up to 5 pages with that header and re-uploads them as attachments, one embed per page. Restricted works get `SPOILER_` file names.
- **nhentai** — the gallery page sits behind a Cloudflare challenge that answers `403 Just a moment…` to every user agent, so Discord has nothing to unfurl. The JSON API is not challenged: `api/v2/galleries/<id>` returns the title, cover, page count, favourites, upload date and every tag with its type. The cover on `t.nhentai.net` fetches `200 image/webp` for Discordbot UA. **Adult content, one presentation:** the card shows the title, the author (artists and groups) and the cover as `SPOILER_cover.webp`, so the image is hidden until clicked. There is no channel gate and no `full` variant — the link is carded wherever it is posted. Discord's own unfurl of the same URL carries a title and a generic "Read and download…" line and no image, so the cover is the part only this card adds.

Two limits worth knowing. **Discord has no spoiler for embed images** — only an attachment honours the `SPOILER_` prefix, which is why the cover leaves the embed. And a spoiler is redaction, not permission: the image is still adult content outside an age-restricted channel. That is a deliberate choice here, not an oversight.
- **TikTok** — its own oEmbed returns an iframe and no metadata, and the page's `og:title` is the literal string `TikTok · TikTok`. The bot reads `tikwm.com/api`, a public keyless API, for the real caption, author, avatar, cover and counts. Video posts only: photo posts keep the plain clean link.
- **Facebook** — the post page is a login wall and its `og:title` is a generic string, but the public embed iframe at `plugins/post.php?href=<post>&show_text=true` is not: it returns the author, the post text and the media. No token, no browser. Carded forms: `/<page>/posts/<id|pfbid>`, `/reel/<id>`, `/<page>/videos/<id>`, `/watch/?v=<id>` and `permalink.php?story_fbid=`. Posts that forbid embedding, and posts that need a login to view, answer "no longer available" and then the bot sends the plain clean link.
- **Instagram** — two presentations, because the platform splits the same way Discord does. **Photo posts** (`/p/`): the page carries `og:title` (author plus caption), `og:description` (likes and comments), `og:image` and `og:url`, and Discord shows none of it — posted raw, the URL produced zero embeds. The bot reads the tags with a browser user agent and builds the card. **Carousels:** Instagram's own page exposes only one `og:image`, so the fixer page is read as well — it lists every image in order, and `vxinstagram.com/offload/<id>/<n>` serves each one as a stable URL that Discord proxies (`image/webp`, 1440 px wide). Signed Instagram CDN URLs are avoided on purpose: they expire. **Reels and TV posts** (`/reel/`, `/reels/`, `/tv/`): a video, and Discord only plays a video it unfurls itself. An embed of ours in the same message suppresses that unfurl entirely (verified: one embed, no video), and an MP4 handed to an embed's `video` field is dropped. So a video post gets no card at all — one line holding the clean link and a **masked** `[▶ reel](vxinstagram.com/…)` link. Discord unfurls masked links too, so the player appears with the caption and counts while the fixer host stays out of the visible text. If that fixer is ever gone, the post degrades to the clean link only.
- **Threads** — the page has the post text in `og:description`, **but only for a browser user agent**. Crawled as `Discordbot` it returns a 107 KB shell with no description, which is why Discord's own card shows an author and no words. The bot fetches the page once as `Mozilla/5.0`. A text-only post's `og:image` is the author's avatar, so that goes in the corner rather than across the card.

Why the other two sites get no card: Misskey already answers Discord's crawler with complete OpenGraph tags, including an image that fetches, and the URL was confirmed to unfurl. YouTube has a native player. Do not assume a site "unfurls fine" because its tags are fetchable from your machine — Instagram's are, and Discord still renders nothing. Evidence for each is in [docs/saucybot-url-inventory.md](docs/saucybot-url-inventory.md).

Every carded link appears in the message wrapped in angle brackets, `<https://…>`, so Discord does not unfurl it a second time next to the card. A card is decoration and degrades: a rejected attachment falls back to the embed alone, and a missing **Embed Links** permission falls back to the plain clean link.

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
| Instagram | live (`mdxt`, `psln`) | `/share/` still fake: `200`, no redirect → silence | **real code** — photo card read back from Discord; reel read back as a playable video embed |
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
- **The bot cannot remove an embed from your message in a DM.** Suppressing embeds on a message you did not author needs `Manage Messages`, and DM channels have no permissions, so Discord answers `404` (verified). Wrap the link in angle brackets — `<https://…>` — and Discord shows no preview on your message; the bot still parses it and its own reply carries the preview.
- Nothing is stored: no database, no cache, no message logging beyond the one `console.log` per cleaned link.
- Limits: 4 s per hop, 3 hops, 5 links per message. A failed lookup leaves the link untouched rather than guessing.
- Card limits, shared by every card in the message: 10 embeds, 10 attachments, 5 Pixiv pages per work, 8 MB of attachments, 6 s per request. A card that does not fit the budget is skipped whole, and a card that cannot be built leaves the plain cleaned reply — never an error.
