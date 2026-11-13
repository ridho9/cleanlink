# cleanlink

A Discord bot that strips trackers from share links. You DM it a link, it replies with the clean one. That's the whole product.

It exists because the newer share formats (`threads.com/share/<code>`, `vm.tiktok.com/<code>`, …) hide the real target behind an opaque code. Only the server knows the mapping, so the bot resolves the redirect once and hands back the canonical URL without the tracking parameters.

## Requirements

Node 26 and pnpm are pinned in [.mise.toml](.mise.toml), so [mise](https://mise.jdx.dev) handles both:

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

- **DMs and server channels.** In a DM it just replies. In a server channel it also removes the preview card from your message, if it has been given `Manage Messages`. It removes the card when the message arrives and once more after the reply is sent, because Discord's preview sometimes arrives after the first removal.
- **The typing indicator only appears on messages it can act on.** A link no rule owns, or a message with no link, gets no indicator and no reply — the check is a regex pass, so nothing is fetched to find out. The indicator replaced a 👀 reaction: a reaction on someone's message can notify them, and the indicator notifies nobody. It is refreshed every 8 s while the bot works and stops when the reply lands.
- **`nh/<id>` stands in for an nhentai link.** Send `nh/693549` (or `nh/#693549`) and the bot replies with the real gallery link plus the card. Any case works (`NH/693549`), a leading zero is dropped, and a `/nh/<digits>` path inside some other URL is **not** treated as a shorthand.
- **Silent unless it changed something.** Links it does not handle, links with nothing to strip, and failed lookups all get no reply. A link that gets a card is an exception: it is answered even when it had nothing to strip, because the card itself is the reply.
- **Delete your message and the reply goes too.** The bot removes its reply and any follow-up when the message it answered is deleted, also when that happens while the cards are still being built. This works for the last 1000 messages answered since the bot started; older replies stay.
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
| Threads | `/share/<code>` share links, strips `xmt`, `slof` | **yes** — author, avatar, post text, the post it replies to or quotes, stats, images, video |
| Instagram | `/share/…` links, strips `igsh`, `igshid`, `mdxt`, `psln` | **yes** — one embed per image, for photos, carousels and reels; a reel gets its video: attached when it fits 9.5 MB, otherwise a follow-up link that plays |
| TikTok | `vm.` / `vt.` short links, strips `is_from_webapp`, `sender_device`, `web_id`, `_t`, … | **yes** — caption, author, cover, counts from `tikwm.com` |
| Twitter / X | strips `s`, `t`, `ref_src`, `ref_url` | **yes** — text, avatar, stats, quote, still |
| YouTube | on `watch` links keeps only `v`, so playlist and radio parameters go; short links lose `si`, `feature` | no, the native player is better |
| Facebook | `fb.watch`, `/share/…`, strips `rdid`, `refid`, `sfnsn`, `__tn__`, `share_url`; on `story.php` / `permalink.php` keeps only `story_fbid` and `id` | **yes** — author, text and media from the public embed iframe, or from a mirror when the post refuses it; a public group post (`/groups/<group>/permalink/<id>`) is read from the page's own tags, which the iframe never serves |
| Reddit | `/r/<sub>/s/<code>` share links resolve to `/r/<sub>/comments/<id>/<slug>/`; every query parameter on the permalink goes. A `redd.it/<id>` short link resolves to `/comments/<id>`, and a bare `/gallery/<id>` link gets the same card, built from the post its feed names | **yes** - title, subreddit and author from the post's Atom feed, the video attached from `v.redd.it` HLS (`yt-dlp`), or every uploaded picture at its own size - one embed each, a gallery in its own order |
| Pixiv | nothing to strip | **yes** — the artwork pages, re-uploaded |
| nhentai | nothing to strip; `nh/<id>` shorthand works as input, in any case | **yes** — title, author, and the cover attached behind Discord's spoiler flag |
| MangaDex | nothing to strip | **yes** — cover, title, author, synopsis, genres and themes, status, content rating, rating and follows; an erotica or pornographic cover goes behind the spoiler flag |
| Misskey | nothing to strip | no, Discord's own preview is complete |

Common trackers (`utm_*`, `fbclid`, `gclid`, `twclid`, `yclid`, `mibextid`, `_ga`, `_gl`) are stripped everywhere.

A link inside Discord spoiler markup (`||…||`) is left alone: not cleaned, not carded, no reply. It is hidden on purpose, and a card would show it again.

Spotify and Google were removed on purpose: only fake share codes had ever been tried against them, so they sat in the table as untested. Add them back from [src/rules.ts](src/rules.ts) once a real link from each has been checked. Reddit came back that way: a real share link was checked on 2026-11-09.

## Preview cards

Nine sites get a card the bot builds itself, because Discord's own preview fails on each of them. Every card comes from the site's own data — no third-party renderer is used anywhere.

| Site | Source | What the card shows |
|---|---|---|
| **X** | `api.fxtwitter.com`, `video.twimg.com` | full text, avatar, quote as a blockquote, Replies/Retweets/Likes/Views, up to ten full-size embeds, one per image (the quoted tweet's pictures included), then up to ten more pictures as attachments — Discord holds ten embeds and ten files, so X's twenty fit one message — with the numbering naming the post's real count; a tail picture that no longer fits the 9.5 MB budget ends the tail, and the video or GIF is attached as `video.mp4` — Discord cannot play X video inside an embed, but it plays an attached file. X offers several renditions; the bot takes the **largest that fits the 9.5 MB budget**, and the poster frame appears only when nothing could be attached, so the player is not shown twice |
| **Pixiv** | `ajax/illust` + `ajax/illust/<id>/pages` | title, author, tags, up to 5 pages downloaded with a pixiv `Referer` and re-uploaded, because `i.pximg.net` answers `403` without it and Discord never sends one. An R-18 work names no files to an anonymous client (every `urls` field is null, `/pages` answers `404` as for a missing work), so its pages come from `pixiv.re`, which serves page N of a work id, and they go out as `SPOILER_` files that no embed claims — an embed that shows that same file drops Discord's spoiler mark, so a restricted card is text only and the pictures arrive blurred. `PIXIV_COOKIE` is optional: with a signed-in session the pages come from pixiv itself instead. SaucyBot, the reference implementation, keeps its own pixiv account for this; this bot reads the mirror instead |
| **Threads** | the post JSON embedded in the page, fetched as `Mozilla/5.0`; the page's OpenGraph tags when the JSON is missing | laid out like the X card: author and avatar, post text, Replies/Reposts/Quotes/Likes, timestamp, one embed per carousel image (up to 10) and the video attached when it can be had. A reply quotes its parent (the last edge of `containing_thread`) and a quote post its `quoted_attachment_post` (`quoted_post` on older pages); a post without media shows the quoted post's or the parent's; a video too large to attach becomes a play link only under the 15 MB unfurl ceiling, otherwise its poster stands alone. When the page answers with neither the JSON nor the tags — a deleted post, or one limited to some audiences — the card says `Post not available` instead of leaving the reply blank. Crawled as `Discordbot` the page returns a 107 KB shell with no description, which is why Discord's own Threads card has no words |
| **Instagram** | page + `api/v1/oembed` + `/p/<shortcode>/embed/captioned/`; behind a login wall, `oginstagram.com` and `vxinstagram.com` | display name, the **full** caption, Likes/Comments, one embed per carousel image. A reel's MP4 comes from the payload's `video_url`, or from `yt-dlp` when the payload omits it (seen on reels with licensed music); it is attached when it fits, otherwise posted as a follow-up link that Discord plays. The clean frame is used only when no video can be had. Instagram sometimes answers the server with a login page (no `og:title`); only then the card comes from the mirrors: text, counts and image count from oginstagram, the other carousel images from vxinstagram, stills only. The note `instagram fell back to …` in the review shows how often |
| **Facebook** | `plugins/post.php`, whose JSON-LD names each picture at its uploaded size; `yt-dlp` for video; and `facebed.com` for what both refuse. A group post is the exception: the iframe answers "Unavailable" for every one, and the group page itself carries the tags | author, post text, every picture at the size it was uploaded, and the video attached when it can be had; a reel too large to attach is sent as the `facebed.com` page link instead, which Discord unfurls into a player with the caption. A group post shows the group, the text and its picture. A single-photo `story.php` or `permalink.php` post gets one more request: the page as a link crawler, whose `og:image` names the upload, and the `ctp` crop parameter is dropped from it (measured 2026-11-09: 370x498 from the iframe, 1523x2048 from the page) |
| **Reddit** | the post's Atom feed (`/comments/<id>.rss`, which answers for a permalink, a `/comments/<id>` link and a `/gallery/<id>` link alike), read as `cleanlink/1.0 (+https://github.com/ridho9/cleanlink)`; for a gallery, the embed view at `embed.reddit.com`; and `v.redd.it` HLS through `yt-dlp` | title, `r/<sub> · u/<author>`, and the video attached from the HLS playlist of a video post - the only rendition an anonymous reader gets (the `DASH_*.mp4` files answer `403`). A gallery post links its gallery page, which a login wall hides, but the embed view renders every page of it: each `<li slot="page-N">` names its picture's media id, and that id answers unsigned and full size on `i.redd.it` (measured 2026-11-09: four pictures, 2048×1536 of a 1080 px preview, one embed each, in the post's order; the preview's own name is the media id, and older previews put it after `-v0-`). A crosspost links the gallery post it shows, which owns the pages: the view ignores the subreddit and the slug, so the id in the path is the gallery's (measured 2026-11-11: six pictures of `r/malaysia/comments/1owmmtp` came from `.../comments/1owmmca`). A picture post shows the `i.redd.it` file at its own size, and the feed's 640 px preview is the fallback. No score and no body: Reddit's JSON endpoints answer an anonymous reader with `403`. The bare `Mozilla/5.0` is refused too, which is why both the share resolution and the feed name this client. A `429` from the embed view is retried once after a second — the host's rate limit, measured as `x-ratelimit-remaining: 0` — and a gallery that still does not answer costs the gallery pictures, never the card |
| **TikTok** | `tikwm.com/api` | caption, author, avatar, Plays/Likes/Comments, and the video attached from TikTok's own CDN. Its own oEmbed returns an iframe only, and the page's `og:title` is the literal `TikTok · TikTok` |
| **nhentai** | `api/v2/galleries/<id>` | title, author, and the cover attached as `SPOILER_cover.webp`. The gallery page is a Cloudflare challenge, but the API is not. `NH/693549` and `nh/693549` both work as shorthand |
| **MangaDex** | `api.mangadex.org/manga/<id>` + `statistics/manga/<id>` | title, author (and artist when different), the English synopsis up to the first `---` rule (what follows it is links, not story; kept as MangaDex's own Markdown, cut at a space before 350 characters), one line of genres and themes (`Romance · Comedy · School Life`, at most 8; format and content tags such as `Oneshot` or `Gore` are left out), `Ongoing · Safe`, `⭐ 9.46 · 🔖 133,886` (rating and follows), and the 512 px cover. An `erotica` or `pornographic` cover is attached as `SPOILER_cover.jpg` instead. The title page is a proof-of-work challenge, and the API sends a browser user agent to the same challenge, so the bot names itself (`cleanlink (+…)`) there. Chapter links get no card |

Why the other two get no card: **Misskey** already answers Discord's crawler with complete OpenGraph tags, and its URL was confirmed to unfurl; **YouTube** has a native player.

### Limits that shape every card

- **One embed per image.** A Discord embed has one `image` and one `thumbnail` field — no gallery — so two full-size images need two embeds. The second image is never put in `thumbnail`; a shrunk version was rejected.
- **The stats are one line, not fields.** Discord keeps inline fields in a row on the desktop client but stacks them one per row on a phone, so four numbers became four rows there. Every card ends its text with one line of icon and number instead — `💬 12 · 🔁 34 · ❤️ 56 · 👁 7,890` on X, `▶ 1,099,639 · ❤️ 130,482 · 💬 16,754` on TikTok — which reads the same at any width.
- **An embed suppresses link unfurls.** A message holding our card never creates Discord's own preview, and an MP4 in `embed.video` is dropped outright. That is why a video can only arrive as an attachment or as its own message.
- **When nothing fits the upload budget, a media URL under 15 MB goes out as a second message.** Discord unfurls it into a player with no upload, and it has to be alone in its message; past 15 MB Discord only prints the URL, so no link is sent. The URL is masked as `[▶ Play video](…)`, because a signed CDN URL runs past 1000 characters and Discord would print it in full. At most two such follow-ups per reply, one per card, and the card then omits the poster frame so the player is not shown twice.
- **Every single-file rendition is tried, not only the best.** yt-dlp lists them all (`hd`, `sd` on Facebook); the largest that fits 9.5 MB is attached. If none fits, the follow-up uses the largest file up to 15 MB, because Discord does not unfurl larger ones; when every file is larger, the follow-up is skipped.
- **No spoiler for embed images.** Only an attachment honours the `SPOILER_` filename prefix, which is why the nhentai cover and an adult MangaDex cover leave the embed. A spoiler is redaction, not permission.
- **Budgets per message, shared by every card:** 5 cards, 10 embeds, 10 files, 9.5 MB of attachments. A card that would break a budget is skipped whole.
- **A card is decoration and degrades:** a rejected attachment resends the embeds alone, a missing **Embed Links** permission resends the plain links. Never an error, never a lost clean link.
- **Card text is third-party text:** everything passes through `escapeMarkdown`, and composition happens before clipping so our own `> **Quoting …**` markup survives.

Adding a card is a table entry in [src/cards/index.ts](src/cards/index.ts) plus a builder module beside it.

## What has actually been verified

Query-parameter stripping is deterministic and covered by tests for every site. Resolving the opaque share links is the fragile part, so here is what was checked against the live networks rather than a stub:

| Site | Param strip | Share resolve | Card |
|---|---|---|---|
| Threads | live | **real code** — `302` → clean post URL | **real code** — text, author and avatar from the page, card sent and read back |
| Instagram | live (`mdxt`, `psln`, `srtk`) | `/share/` still fake: `200`, no redirect → silence | **real code** — single post, 4- and 10-image carousels and a reel all read back from Discord |
| TikTok | live | **real code** — `vt.tiktok.com` → `/@user/video/<id>` | **real code** — `tikwm.com` answered for a real video, card sent and read back |
| Facebook | live (`share_url`) | **real code** — `/share/<code>` → `/posts/<id>`, `/reel/<id>`, `story.php?story_fbid=…`; `/share/p/<code>` → `/groups/<group>/permalink/<id>` | **real code** — text, author and pictures from `plugins/post.php` for a post, a reel and a watch link; cards sent and read back. A 5-picture post builds with all five at their uploaded `900x1295`, not the grid's `394x394`: the page's JSON-LD block names the file, and that fetch answered `200 image/jpeg`. A public group post builds from its page tags: group name, text, `scontent` picture |
| Twitter / X | live | n/a | **real code** — built from `api.fxtwitter.com`, sent to Discord and read back |
| YouTube | live | n/a | n/a |
| nhentai | n/a | n/a | **real code** — `api/v2/galleries/<id>` and a `t.nhentai.net` cover that Discord can fetch; card built and inspected, gated on NSFW |
| MangaDex | n/a | n/a | **real code** — a safe and a pornographic title built from the live API: the safe cover as the embed image (`uploads.mangadex.org` answers `Discordbot` with `200 image/jpeg`), the other as a 131 KB `SPOILER_cover.jpg` |
| Pixiv | n/a | n/a | **real code** — 2 pages fetched with a pixiv `Referer`, uploaded, embed rendered |

Four of the six tracker sites have resolved a real share link, and every cleaned URL was re-fetched to confirm it still serves the post. Every card has been built against the live site and read back from Discord, attachment and embed intact. If a site silently does nothing, this table is the first place to look.

## Logs and the daily review

Every message the bot acts on ends with one `[msg]` line in the journal: where it came from, how long it took, how it ended, and for every URL what happened to it. Full URLs are logged on purpose, because a failure cannot be investigated without the link. Errors nothing else caught get an `[error]` line with the message id.

```
[msg] {"id":"…","where":"myserver #general","ms":3034,"reply":"sent","urls":[
  {"in":"https://www.facebook.com/share/v/…","clean":"https://…/videos/…","card":"facebook","media":"video","notes":["…"]}]}
```

| Field | Values |
|---|---|
| `reply` | `sent`, `nothing` (no change, no card), `refused` (403/404 from Discord), `deleted` (original deleted before the reply), `withdrawn` (reply sent, then removed because the original was deleted), `error`. Logs from before `withdrawn` existed count both cases as `deleted`. |
| `clean` | the cleaned URL, `unchanged`, `error` |
| `resolve` | `failed` (request failed twice), `fallback` (share link landed on a front page) |
| `redirect` | `none`: a share link that did not redirect (fake or expired code) |
| `card` | the site id; `<site>:none` (builder produced nothing), `<site>:budget`, `<site>:error` |
| `media` | `video`, `follow_up` (too large, sent separately), `unfurl` (handed to a mirror), `images:<n>`, `text` |
| `notes` | the log lines written while that URL was handled |

The code enforces these values. `Outcome` and `Marks` in [src/trace.ts](src/trace.ts) define the `reply` field and the per-URL fields, and `mark()` accepts only a field and value from `Marks`, so `tsc` rejects a misspelled field or value. `scripts/review.ts` reads the same types. To add a value, add it to the type first.

The review reads them back:

```sh
mise run review                       # last 24 hours from BOT_HOST
SINCE='3 days ago' mise run review    # any journalctl --since value
```

It prints how messages ended, a per-site table, problems grouped by kind with up to three example URLs and their notes, errors with a stack excerpt, and the slowest messages.

## Adding a site

Everything site-specific is data in [src/rules.ts](src/rules.ts):

```ts
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

The engine ([src/clean.ts](src/clean.ts)) needs no changes. Add a case to [test/clean.test.ts](test/clean.test.ts) with a stubbed `fetch`, then try one real link by hand.

## Tests

```sh
mise run test        # type-check, then the unit tests
mise run typecheck   # type-check only
```

The cleaning logic is plain functions with `fetch` injected, so the whole suite runs offline in under 100 ms with no Discord token.

## TypeScript

The code is TypeScript that Node runs directly: Node removes the types and runs what is left. There is no build step and no output directory. This works only for *erasable* syntax, so `enum`, `namespace`, parameter properties and `import x = require()` are not allowed; use string-literal unions and `as const` objects in their place. `tsconfig.json` sets `erasableSyntaxOnly`, so `tsc` rejects that syntax before Node does.

Node does not check types. `mise run test` and `mise run deploy` run `tsc` first, so code with a type error cannot be deployed. Relative imports keep the `.ts` extension (`import { note } from './trace.ts'`).

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
- Limits: 4 s per attempt, 3 hops, 5 handled links per message. A hop that fails is retried once, so a hop can take 8 s. Links no rule owns do not spend the 5-link cap. A failed lookup leaves the link untouched rather than guessing.
- Card limits, shared by every card in the message: 10 embeds, 10 attachments, 6000 characters of embed text, 5 Pixiv pages per work, 9.5 MB of attachments. A page or JSON body may be 8 MB. A page gets 6 s (Pixiv 20 s, Facebook 15 s), a media file 10 s, and a yt-dlp download 30 s. A card that does not fit the budget is skipped whole, and a card that cannot be built leaves the plain cleaned reply — never an error.
