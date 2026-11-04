# SaucyBot URL inventory

Source: [`Sn0wCrack/saucybot-discord`](https://github.com/Sn0wCrack/saucybot-discord), branch `v2`, files under `SaucyBot/Site/`. Read from the code, not the README — the README omits Bluesky and disagrees with the code on which sites are enabled.

Treatment is one of four things:

| Treatment | Meaning |
|---|---|
| **Embed** | Fetches data from an API and builds an `EmbedBuilder`: author, text, image, fields |
| **Rename** | Rewrites the host to a third-party renderer and posts the link as text; *Discord* then unfurls it |
| **Attach** | Downloads media and re-uploads it as a file attachment |
| **Unwrap** | Decodes a URL out of a wrapper and posts it |

## Per-site

`cleanlink today` is the last column: what our bot does with that site right now.

| Site | Input URL | Treatment | Output | Live status | cleanlink today |
|---|---|---|---|---|---|
| ArtStation | `artstation.com/artwork/<hash>` | Embed | title, author, up to 8 extra images | working | no |
| Bluesky | `bsky.app/profile/<user>/post/<id>` | Embed | text, images, engagement; video → **rename** to `r.bskyx.app` link | working | no |
| DeviantArt | `deviantart.com/<user>/art/<slug>-<id>` | Embed | main image + metadata | **disabled** upstream (IP rate limited) | no |
| e621 | `e621.net/posts/<id>` | Embed | higher-res image, tags | **disabled** upstream | no |
| E(x-)Hentai | `e[x-]hentai.org/g/<id>/<hash>` | Embed | cover, title, score | e-hentai only | no — but `nhentai.net/g/<id>` is carded instead, from its JSON API, NSFW-gated |
| FurAffinity | `furaffinity.net/view/<id>`, `/full/<id>` | Embed | image via the faexport API | working | no |
| FurAffinity (alt) | same | **Rename** → `xfuraffinity.net` | plain link | alternative to the above | no |
| HentaiFoundry | `hentai-foundry.com/pictures/user/<user>/<id>/<slug>` | Embed | image | working | no |
| **Instagram** | `instagram.com/(p\|reel\|reels)/<id>` | **Rename** → `vxinstagram.com` | plain link | **disabled** upstream (broken) | **params + card** — photo posts carded from the page's OpenGraph tags; video posts get a `vxinstagram.com` link so Discord renders a player (SaucyBot's dead renderer, replaced by a live one) |
| Misskey | `misskey.io` / `misskey.design` / `oekakiskey.com` + `/notes/<id>` | Embed | text, images, NSFW gate | misskey.io only | no card — Discord's own preview already shows author, text and image |
| Newgrounds | `newgrounds.com/art/view/<user>/<slug>` | Embed | image + rating | **broken** upstream | no |
| Pixiv | `pixiv.net/…/artworks/<id>` | **Attach** | up to 5 images; ugoira → mp4 via ffmpeg | working (needs cookie) | **attach** — built; up to 5 pages re-uploaded, because `i.pximg.net` is 403 without a Referer |
| Reddit | `reddit.com/media?url=<encoded>` | **Unwrap** | decoded media URL | working (this is *only* media links) | **removed** — no rule in `src/rules.js`; dropped until checked with a live link |
| Twitter / X | `(twitter\|x\|nitter).(com\|net)/<user>/status/<id>` | Embed + **Rename** fallback | author, full text incl. QRT blockquote, replies/retweets/likes/views, full-res image; video or too-long text → `fxtwitter.com` link | working | **params + card** — embed built from `api.fxtwitter.com` |
| Twitter / X (Vx) | same | Embed + **Rename** fallback | as above via `api.vxtwitter.com`, fallback `vxtwitter.com` link | alternative implementation | **params + card** — same input URLs as the row above, so the same card |
| **Threads** | `threads.com/share/<code>`, `threads.net/t/<code>`, `threads.com/@user/post/<id>` | — (not handled) | — | — | **yes** — resolves `/share/` and `/t/` to the post, strips `xmt`, `slof` and the whole query on permalinks; **card** from the page's OpenGraph tags (browser UA only) |
| **TikTok** | `vm.tiktok.com/<code>`, `vt.tiktok.com/<code>`, `tiktok.com/@user/video/<id>` | — (not handled) | — | — | **yes** — resolves the shortener to the video, drops `_t` and the app-share tokens; **card** from `tikwm.com` (caption, author, cover, counts) |
| **YouTube** | `youtube.com/watch?v=<id>`, `youtu.be/<id>` | — (not handled) | — | — | **yes** — drops `si`, `feature`; native player does the rest |
| **Facebook** | `facebook.com/share/<code>`, `fb.watch/<code>`, `/posts/`, `/permalink/`, `/videos/`, `/reel/` | — (not handled) | — | — | **yes** — unwraps `/share/` and `fb.watch`, drops `rdid`, `refid`, `sfnsn`, `__tn__`, `share_url`; **card** from the public `plugins/post.php` iframe (author, text, media) for posts, reels, videos and watch links |

## Counts

- **Embed** (API-driven): ArtStation, Bluesky, DeviantArt, e621, E(x-)Hentai, FurAffinity, HentaiFoundry, Misskey, Newgrounds, Pixiv, Twitter
- **Rename only**: Instagram (`vxinstagram.com`), FurAffinity alt (`xfuraffinity.net`), Bluesky video (`r.bskyx.app`), Twitter video fallback (`fxtwitter.com` / `vxtwitter.com`)
- **Attach**: Pixiv (ugoira)
- **Unwrap**: Reddit (`media?url=` only)

So the domain-rename trick is used on **four** sites, and every one of those renames points at a third-party renderer that must exist and must serve OpenGraph tags to Discord's crawler. Everything else is SaucyBot fetching an API and drawing the card itself. None of the renames strip tracking parameters — that is not what SaucyBot does at all.

## Where that leaves each of our six sites

Overlaps with SaucyBot: **Twitter / X** and **Instagram**. Ours alone: **Threads**, **TikTok**, **YouTube**, **Facebook**.

- **Twitter / X** — built. `api.fxtwitter.com` answers `200 application/json` for a real status, so the card carries author, avatar, full text, QRT text, stats and a still.
- **Instagram** — built, without borrowing SaucyBot's approach. Its rename renderer is dead, but Discord unfurls nothing for the link (verified: zero embeds), while the page serves `og:title`, `og:description` and an `og:image` that fetches `200`. Reading those tags gives the card SaucyBot's dead renderer was supposed to produce.
- **Threads** — built, and SaucyBot has nothing to teach here. Its OpenGraph tags do carry the post text, but only for a browser user agent: `Discordbot` gets a 107 KB shell without `og:description`. That is why Discord's own card is wordless, and one `Mozilla/5.0` fetch fixes it.
- **TikTok** — nothing found. The native card shows a generated share-card image and a generic title; oEmbed now returns an iframe with no metadata.
- **YouTube** — nothing needed. The native player is the best result already.
- **Facebook** — nothing found. `fixfacebook.com` does not resolve; `/share/` unwrapping is where we stop.
