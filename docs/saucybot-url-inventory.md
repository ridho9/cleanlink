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

| Site | Input URL | Treatment | Output | Live status |
|---|---|---|---|---|
| ArtStation | `artstation.com/artwork/<hash>` | Embed | title, author, up to 8 extra images | working |
| Bluesky | `bsky.app/profile/<user>/post/<id>` | Embed | text, images, engagement; video → **rename** to `r.bskyx.app` link | working |
| DeviantArt | `deviantart.com/<user>/art/<slug>-<id>` | Embed | main image + metadata | **disabled** upstream (IP rate limited) |
| e621 | `e621.net/posts/<id>` | Embed | higher-res image, tags | **disabled** upstream |
| E(x-)Hentai | `e[x-]hentai.org/g/<id>/<hash>` | Embed | cover, title, score | e-hentai only |
| FurAffinity | `furaffinity.net/view/<id>`, `/full/<id>` | Embed | image via the faexport API | working |
| FurAffinity (alt) | same | **Rename** → `xfuraffinity.net` | plain link | alternative to the above |
| HentaiFoundry | `hentai-foundry.com/pictures/user/<user>/<id>/<slug>` | Embed | image | working |
| **Instagram** | `instagram.com/(p\|reel\|reels)/<id>` | **Rename** → `vxinstagram.com` | plain link | **disabled** upstream (broken) |
| Misskey | `misskey.io` `/ misskey.design` `/ oekakiskey.com` + `/notes/<id>` | Embed | text, images, NSFW gate | misskey.io only |
| Newgrounds | `newgrounds.com/art/view/<user>/<slug>` | Embed | image + rating | **broken** upstream |
| Pixiv | `pixiv.net/…/artworks/<id>` | **Attach** | up to 5 images; ugoira → mp4 via ffmpeg | working (needs cookie) |
| Reddit | `reddit.com/media?url=<encoded>` | **Unwrap** | decoded media URL | working (this is *only* media links) |
| Twitter / X | `(twitter\|x\|nitter).(com\|net)/<user>/status/<id>` | Embed + **Rename** fallback | author, full text incl. QRT blockquote, replies/retweets/likes/views, full-res image; video or too-long text → `fxtwitter.com` link | working |
| Twitter / X (Vx) | same | Embed + **Rename** fallback | as above via `api.vxtwitter.com`, fallback `vxtwitter.com` link | alternative implementation |

## Counts

- **Embed** (API-driven): ArtStation, Bluesky, DeviantArt, e621, E(x-)Hentai, FurAffinity, HentaiFoundry, Misskey, Newgrounds, Pixiv, Twitter
- **Rename only**: Instagram (`vxinstagram.com`), FurAffinity alt (`xfuraffinity.net`), Bluesky video (`r.bskyx.app`), Twitter video fallback (`fxtwitter.com` / `vxtwitter.com`)
- **Attach**: Pixiv (ugoira)
- **Unwrap**: Reddit (`media?url=` only)

So the domain-rename trick is used on **four** sites, and every one of those renames points at a third-party renderer that must exist and must serve OpenGraph tags to Discord's crawler. Everything else is SaucyBot fetching an API and drawing the card itself. None of the renames strip tracking parameters — that is not what SaucyBot does at all.

## Against cleanlink's six sites

| Site | SaucyBot | cleanlink today | Feasible next step |
|---|---|---|---|
| Twitter / X | embed via `api.fxtwitter.com` | strip params | privileged position: the API works and Discord renders photos natively; only QRT text, stats and video are missing |
| Instagram | rename to `vxinstagram.com` (disabled, renderer dead) | strip params | nothing: media is 403 to every UA |
| Threads | not handled | strip params | nothing found; native card is title + broken thumbnail |
| TikTok | not handled | strip params | nothing found; native card is TikTok's logo |
| YouTube | not handled | strip params | nothing needed; native player |
| Facebook | not handled | resolve `/share/` | nothing found (`fixfacebook.com` is dead) |
