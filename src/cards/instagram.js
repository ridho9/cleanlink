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
  getJson,
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
  const url = new URL(href);
  const video = isVideo(url.pathname);


  // Three first-party sources, each for what only it has:
  //   the post page   — display name and counts, as OpenGraph tags
  //   oEmbed          — the full caption, the handle, and a thumbnail that is
  //                     neither square-cropped nor stamped with a play button
  //   embed/captioned — one `display_url` per carousel image
  const shortcode = url.pathname.split('/').filter(Boolean).pop();
  const oembedUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(href)}`;
  const [page, embedPage, oembed] = await Promise.all([
    getHtml(href, options),
    getHtml(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, options),
    getJson(oembedUrl, options),
  ]);
  const source = page?.html ?? embedPage?.html;
  if (!source) return null;

  const title = metaContent(source, 'og:title');
  if (!title) return null;

  const rawDescription = metaContent(source, 'og:description') ?? '';
  const prefix = COUNT_PREFIX.exec(rawDescription);
  const suffix = COUNT_SUFFIX.exec(rawDescription);

  // oEmbed's `title` is the caption in full; the OpenGraph one is clipped.
  const caption =
    (oembed?.title ?? '').trim() ||
    CAPTION_IN_TITLE.exec(title)?.[1] ||
    rawDescription.replace(COUNT_PREFIX, '').replace(COUNT_SUFFIX, '');
  const name = title.replace(/\s*on Instagram:.*$/s, '').replace(/\s*\(@[\w.]+\)$/, '');
  const canonical = metaContent(source, 'og:url') ?? href;
  const handle = oembed?.author_name || handleOf(title, canonical, rawDescription);

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

  // Every carousel image, in order, from the embed payload; otherwise the
  // single image the page exposes.
  const media = embedMedia(embedPage?.html ?? '');
  const images = media.images.slice(0, MAX_IMAGES);
  if (images.length === 0) {
    // Single image or a video still: oEmbed's thumbnail keeps the aspect ratio
    // (640×800 rather than a 640×640 crop) and carries no play button. `og:image`
    // is the last resort.
    const single = oembed?.thumbnail_url ?? metaContent(source, 'og:image');
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

  return { embeds, files: [] };
}

/** True for a reel, a reel alias or a TV post. */
function isVideo(pathname) {
  return /(?:^|\/)(?:reel|reels|tv)\//.test(pathname);
}

/**
 * Media references from Instagram's own embed payload.
 *
 * `/p/<shortcode>/embed/captioned/` embeds a JSON blob with `video_url` for a
 * video post and one `display_url` per carousel image. The blob is a JS string
 * literal nested inside a JSON string, so quotes and slashes arrive escaped —
 * sometimes twice. Dropping every backslash is safe here (a URL needs none) and
 * collapses all of that to plain text. These are signed CDN URLs: fine, because
 * Discord proxies them as it renders the message.
 */
function embedMedia(html) {
  const plain = html.replace(/\\/g, '');
  const video = /"video_url":"([^"]+)"/.exec(plain)?.[1] ?? null;
  const images = [...plain.matchAll(/"display_url":"([^"]+)"/g)].map((match) => match[1]);

  return { video, images: [...new Set(images)] };
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
