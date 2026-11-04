// Instagram, split by media type because Discord treats the two differently.
//
// Photos and carousels get a card from the page's OpenGraph tags — Discord
// renders nothing for the link on its own (verified: a raw post produced zero
// embeds). Carousels need one more source: Instagram's page exposes a single
// `og:image`, and yt-dlp knows how many entries a carousel has but will not
// resolve images, so vxinstagram's page is read for the image list — the one
// remaining use of a third party in this file.
//
// Video posts get no card at all: Discord only plays a video it unfurls itself,
// an embed in the same message suppresses that unfurl, and an MP4 handed to an
// embed's `video` field is dropped. So a reel is the clean link plus a masked
// `[▶ reel](…)` link whose target is the direct mp4 yt-dlp resolves — Discord
// unfurls masked links and proxies the file, so nothing is downloaded here. If
// no direct URL can be found, the post falls back to a poster card.

import {
  authorBlock,
  getHtml,
  INSTAGRAM_PINK,
  metaContent,
  toField,
  videoUrl,
} from './shared.js';

// The two pages describe a post differently, so both shapes are parsed.
//
//   instagram.com  og:title       `Name on Instagram: "caption"`
//                  og:description `1M likes, 11K comments - handle on date: "caption"`
//   vxinstagram    og:title       `Name (@handle)`
//                  og:description caption, with `❤️ 1150843   💬 11338` appended
//                                 when the post has counts
const CAPTION_IN_TITLE = /on Instagram:\s*"?(.*?)"?$/s;
const COUNT_PREFIX = /^([\d.,]+[KMB]?)\s+likes?,\s+([\d.,]+[KMB]?)\s+comments?\s*-\s*/i;
const COUNT_SUFFIX = /❤️\s*([\d.,]+[KMB]?)\s*💬\s*([\d.,]+[KMB]?)/;

/** Instagram allows 20 images per carousel; Discord allows 10 embeds a message. */
const MAX_IMAGES = 10;

export async function buildInstagramCard({ href }, options) {
  const url = new URL(href);
  const video = isVideo(url.pathname);


  // instagram.com carries the author, caption and counts. The fixer page is
  // only needed for a carousel's image list.
  const [page, fixerPage] = await Promise.all([
    getHtml(href, options),
    video ? null : getHtml(`https://vxinstagram.com${url.pathname}`, options),
  ]);
  const source = page?.html ?? fixerPage?.html;
  if (!source) return null;

  const title = metaContent(source, 'og:title');
  if (!title) return null;

  const rawDescription = metaContent(source, 'og:description') ?? '';
  const prefix = COUNT_PREFIX.exec(rawDescription);
  const suffix = COUNT_SUFFIX.exec(rawDescription);

  const caption =
    CAPTION_IN_TITLE.exec(title)?.[1] ??
    rawDescription.replace(COUNT_PREFIX, '').replace(COUNT_SUFFIX, '');
  const name = title.replace(/\s*on Instagram:.*$/s, '').replace(/\s*\(@[\w.]+\)$/, '');
  const canonical = metaContent(source, 'og:url') ?? href;
  const handle = handleOf(title, canonical, rawDescription);

  const embed = {
    url: canonical,
    color: INSTAGRAM_PINK,
    footer: { text: 'Instagram' },
  };

  if (name || handle) {
    embed.author = authorBlock(
      [name, handle && `(@${handle})`].filter(Boolean).join(' '),
      'Instagram',
      { url: handle ? `https://www.instagram.com/${handle}/` : canonical },
    );
  }

  if (caption.trim()) embed.description = toField(caption.trim(), 4096);

  const counts = prefix ?? suffix;
  if (counts) {
    embed.fields = [
      { name: 'Likes', value: counts[1], inline: true },
      { name: 'Comments', value: counts[2], inline: true },
    ];
  }

  // Carousel first, from stable fixer URLs; otherwise the post's single image.
  const images = fixerPage ? carouselImages(fixerPage.html, url.pathname) : [];
  if (images.length === 0) {
    const single = metaContent(source, 'og:image');
    if (single) images.push(single);
  }
  if (images.length > 0) {
    embed.image = { url: images[0] };
    if (images.length > 1) embed.footer = { text: `Instagram · 1/${images.length}` };
  }

  // A video post keeps its card — author, caption, counts — and carries the
  // file as an attachment, because Discord suppresses a link unfurl as soon as
  // the message holds an embed. Too large or unresolvable, and the poster frame
  // stays instead.
  const embeds = [embed, ...images.slice(1).map((image, index) => ({
    url: embed.url,
    color: INSTAGRAM_PINK,
    image: { url: image },
    footer: { text: `Instagram · ${index + 2}/${images.length}` },
  }))];

  // The card stays; the video needs its own message, because an embed in the
  // message suppresses link unfurls. The follow-up carries only a masked label,
  // so the long signed URL never appears in the text.
  if (video) {
    const direct = await (options.videoUrl ?? videoUrl)(href, options);
    if (direct) return { embeds, files: [], followUps: [`[reel](${direct})`] };
  }

  return { embeds, files: [] };
}

/** True for a reel, a reel alias or a TV post. */
function isVideo(pathname) {
  return /(?:^|\/)(?:reel|reels|tv)\//.test(pathname);
}

/**
 * Every image of the post, in order, as stable fixer URLs.
 *
 * The fixer page lists one `<img>` per carousel entry, so the distinct image
 * URLs in document order give the indices that `/offload/<id>/<n>` expects.
 * Signed Instagram CDN URLs are avoided on purpose: they expire. yt-dlp knows
 * how many entries there are but refuses to resolve images, so it cannot
 * replace this.
 */
function carouselImages(html, pathname) {
  const id = pathname.split('/').filter(Boolean).pop();
  if (!id) return [];

  const seen = new Set();
  for (const match of html.matchAll(/https:\/\/scontent[^"\\ ]+/g)) {
    seen.add(match[0]);
    if (seen.size >= MAX_IMAGES) break;
  }
  if (seen.size === 0) return [];

  return [...seen.keys()].map((_, index) => `https://vxinstagram.com/offload/${id}/${index}`);
}

/**
 * The account handle: `(@handle)` on the fixer page, the first path segment of
 * the canonical URL on Instagram's, or worst case the name in the description.
 * `/p/<id>/` has no handle in its path, which is why the canonical URL is used
 * and not the incoming one.
 */
function handleOf(title, canonical, description) {
  const inline = /\(@([\w.]+)\)/.exec(title)?.[1];
  if (inline) return inline;

  const reserved = new Set(['p', 'reel', 'reels', 'tv', 'share']);
  const first = new URL(canonical).pathname.split('/').filter(Boolean)[0];
  if (first && !reserved.has(first)) return first;

  return /-\s+([\w.]+)\s+on\s+/i.exec(description)?.[1] ?? '';
}
