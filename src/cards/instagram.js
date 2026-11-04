// Instagram, split by media type because Discord treats the two differently.
//
// Photo posts get a card built from the page's OpenGraph tags — Discord renders
// nothing for the link on its own (verified: a raw post produced zero embeds).
//
// Video posts get no card at all: Discord only plays a video it unfurls itself,
// an embed in the same message suppresses that unfurl, and an MP4 handed to an
// embed's `video` field is dropped. So a reel is the clean link plus a masked
// `[▶ reel](vxinstagram.com/…)` link — Discord unfurls masked links, so the
// player appears while the fixer host stays out of the visible text.
//
// Carousels are why the photo path reads the fixer page rather than Instagram's:
// Instagram's own page carries a single `og:image`, while the fixer page lists
// every image in order, and `vxinstagram.com/offload/<id>/<n>` serves each one
// as a stable, proxied URL that Discord fetches happily.

import {
  authorBlock,
  getHtml,
  INSTAGRAM_PINK,
  metaContent,
  toField,
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
  // A reel or a TV post is a video. No card, or Discord never unfurls it.
  //
  // The fixer link goes in as a masked link: Discord unfurls it all the same
  // (verified — a video embed appears), but the message shows only the label,
  // so the third-party host stays out of the text.
  const video = fixerLink(href);
  if (video) return { embeds: [], files: [], extraLines: [`[▶ reel](${video})`] };

  const url = new URL(href);
  // Two pages, for two different reasons: instagram.com carries the counts and
  // the caption as Discord users expect them, and the fixer page lists every
  // carousel image. Either one alone is still enough to build something.
  const [page, fixer] = await Promise.all([
    getHtml(href, options),
    getHtml(`https://vxinstagram.com${url.pathname}`, options),
  ]);
  const source = page?.html ?? fixer?.html;
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
      { url: handle ? `https://www.instagram.com/${handle}/` : embed.url },
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
  const images = fixer ? carouselImages(fixer.html, url.pathname) : [];
  if (images.length === 0) {
    const single = metaContent(source, 'og:image');
    if (single) images.push(single);
  }
  if (images.length > 0) {
    embed.image = { url: images[0] };
    if (images.length > 1) embed.footer = { text: `Instagram · 1/${images.length}` };
  }

  const embeds = [embed, ...images.slice(1).map((image, index) => ({
    url: embed.url,
    color: INSTAGRAM_PINK,
    image: { url: image },
    footer: { text: `Instagram · ${index + 2}/${images.length}` },
  }))];

  return { embeds, files: [] };
}

/**
 * Every image of the post, in order, as stable fixer URLs.
 *
 * The fixer page lists one `<img>` per carousel entry, so the distinct image
 * URLs in document order give the indices that `/offload/<id>/<n>` expects.
 * Signed Instagram CDN URLs are avoided on purpose: they expire.
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

/** The fixer link for a video post, or null. */
function fixerLink(href) {
  const url = new URL(href);
  if (!/(?:^|\/)(?:reel|reels|tv)\//.test(url.pathname)) return null;
  return `https://vxinstagram.com${url.pathname}`;
}
