// Instagram: one card per post, built from three first-party surfaces, each
// used for what only it has.
//
//   the post page    display name and like/comment counts, as OpenGraph tags
//   api/v1/oembed    the full caption (the OpenGraph one is clipped), the
//                    handle, and a thumbnail that is neither square-cropped
//                    nor stamped with a play button
//   embed/captioned  one `display_url` per carousel image, and the video's
//                    clean frame
//
// Discord renders nothing for the link on its own — a raw post produced zero
// embeds — which is why this exists at all. A reel's video comes from the
// embed payload's `video_url` and is handled like X and TikTok: attached when
// it fits the upload budget, otherwise posted as a follow-up link that Discord
// unfurls into a player. When the payload omits `video_url`, yt-dlp supplies
// it. The clean frame is shown only when no video can be had.
//
// Instagram sometimes answers a server with a login wall: a 200 page with no
// OpenGraph tags. Only then are two mirrors used, each for what it has:
// oginstagram for the text, counts and image count, and vxinstagram for the
// images, which it serves unsigned by index (oginstagram signs all but the
// first). Both were checked live on 2026-11-05.

import {
  attachMedia,
  playback,
  authorBlock,
  getHtml,
  getJson,
  readPage,
  INSTAGRAM_PINK,
  MAX_EMBEDS,
  servesImage,
  metaContent,
  statLine,
  toField,
  videoLinks,
} from './shared.ts';
import { note } from '../trace.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

type InstagramOEmbed = {
  title?: string | null;
  author_name?: string | null;
  thumbnail_url?: string | null;
};

type InstagramMedia = {
  images: string[];
  video: string | null;
  isVideo: boolean;
};

/** OpenGraph caption: `Name on Instagram: "caption"`. */
const CAPTION_IN_TITLE = /on Instagram:\s*"?(.*?)"?$/s;
/** OpenGraph counts: `1M likes, 11K comments - handle on date: …`. */
const COUNT_PREFIX = /^([\d.,]+[KMB]?)\s+likes?,\s+([\d.,]+[KMB]?)\s+comments?\s*-\s*/i;
/** oginstagram's description: `🖼️ 4 ❤️ 3,578 💬 47 caption`; the image count only on carousels. */
const MIRROR_PREFIX = /^(?:🖼️\s*(\d+)\s+)?❤️\s*([\d.,]+[KMB]?)\s+💬\s*([\d.,]+[KMB]?)\s*/u;

export async function buildInstagramCard(
  { href }: CardInput,
  options: CardOptions,
): Promise<BuiltCard | null> {
  const url = new URL(href);
  const shortcode = url.pathname.split('/').filter(Boolean).pop();
  // A request that fails outright is caught here: the mirrors below exist for
  // exactly the case where Instagram will not answer us, and reaching them must
  // not depend on the failure being a login wall rather than a timeout. Each
  // failure is already in the log, from `request()`.
  const [page, embedPage, oembed] = await Promise.all([
    readPage(href, options).catch(() => null),
    readPage(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, options).catch(() => null),
    getJson<InstagramOEmbed>(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(href)}`, options).catch(() => null),
  ]);

  // The handler's own URL is only a fallback: an embed-only answer still has a
  // usable caption.
  const source = page?.html ?? embedPage?.html ?? null;
  const title = source ? metaContent(source, 'og:title') : null;
  if (!source || !title) {
    // Say why, so the review can tell a login wall from a dead post.
    const why = !page ? 'page did not answer' : page.html ? `page had no og:title (${page.html.length} bytes)` : `page answered ${page.status}`;
    note(`[card] instagram ${why}`);
    return fromMirrors(shortcode!, options);
  }

  const description = metaContent(source, 'og:description') ?? '';
  const counts = COUNT_PREFIX.exec(description);

  // oEmbed's `title` is the caption in full; the OpenGraph one is clipped.
  const caption =
    (oembed?.title ?? '').trim() ||
    CAPTION_IN_TITLE.exec(title)?.[1] ||
    description.replace(COUNT_PREFIX, '');

  const name = title.replace(/\s*on Instagram:.*$/s, '').replace(/\s*\(@[\w.]+\)$/, '');
  const canonical = metaContent(source, 'og:url') ?? href;
  const handle = oembed?.author_name || handleFrom(title, canonical);

  const embed: CardEmbed = {
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

  // One line, like every other card: inline fields stack on a phone.
  const stats = counts && statLine([['❤️', counts[1]], ['💬', counts[2]]]);
  const text = [caption.trim(), stats].filter(Boolean).join('\n\n');
  if (text) embed.description = toField(text, 4096);

  // Fetched before the frame is chosen: once the player is in the message, the
  // frame only repeats the video's first second.
  const media = embedMedia(embedPage?.html ?? '');
  // Some reels - seen with licensed music - are marked as video in the payload
  // but carry no `video_url`. yt-dlp still resolves the same CDN file.
  const video = media.video ?? (media.isVideo ? await videoLinks(href) : null);
  const played = await attachMedia(video, options);
  const playing = played.kind !== 'none';

  const images = playing ? [] : imagesFor(media, source, oembed);
  if (images.length > 0) {
    embed.image = { url: images[0] };
    if (images.length > 1) embed.footer = { text: `Instagram · 1/${images.length}` };
  }

  const embeds = [
    embed,
    ...images.slice(1).map((image, index) => ({
      url: embed.url,
      color: INSTAGRAM_PINK,
      image: { url: image },
      footer: { text: `Instagram · ${index + 2}/${images.length}` },
    })),
  ];

  return { embeds, ...playback(played) };
}

/**
 * Every image of the post, best source first.
 *
 * A carousel's own `display_url` list is the only complete one. Otherwise the
 * oEmbed thumbnail keeps the aspect ratio (640×800 rather than a 640×640 crop)
 * and carries no play button, and `og:image` is the last resort.
 */
function imagesFor(media: InstagramMedia, source: string, oembed: InstagramOEmbed | null): string[] {
  const carousel = media.images.slice(0, MAX_EMBEDS);
  if (carousel.length > 0) return carousel;

  const single = oembed?.thumbnail_url ?? metaContent(source, 'og:image');
  return single ? [single] : [];
}

/**
 * Media references from Instagram's own embed payload.
 *
 * The payload is a JSON blob nested inside a JS string, so quotes and slashes
 * arrive escaped — sometimes twice. Dropping every backslash is safe (a URL
 * needs none) and collapses all of it to plain text. These are signed CDN URLs,
 * which is fine: Discord proxies them as it renders the message.
 *
 * For a video post the blob's `display_url` is the clean frame and `video_url`
 * is the MP4 itself.
 */
function embedMedia(html: string): InstagramMedia {
  const plain = html.replace(/\\/g, '');
  const images = [...plain.matchAll(/"display_url":"([^"]+)"/g)].map((match) => match[1]);
  const video = /"video_url":"([^"]+)"/.exec(plain)?.[1] ?? null;
  const isVideo = /"is_video":true/.test(plain);
  return { images: [...new Set(images)], video, isVideo };
}

/**
 * The account handle from the page itself, when oEmbed did not answer.
 *
 * `/p/<id>/` has no handle in its path, which is why the canonical URL is used
 * and not the incoming one; `(@handle)` appears only on some surfaces.
 */
function handleFrom(title: string, canonical: string): string {
  const inline = /\(@([\w.]+)\)/.exec(title)?.[1];
  if (inline) return inline;

  const reserved = new Set(['p', 'reel', 'reels', 'tv', 'share']);
  const first = new URL(canonical).pathname.split('/').filter(Boolean)[0];
  return first && !reserved.has(first) ? first : '';
}

/**
 * The card from the mirrors, for when Instagram walls the bot off. Stills only:
 * a mirror's video path is not checked, and a still beats no card.
 */
async function fromMirrors(shortcode: string, options: CardOptions): Promise<BuiltCard | null> {
  const og = await getHtml(`https://www.oginstagram.com/p/${shortcode}/`, options);
  const ogTitle = og && metaContent(og.html, 'og:title');

  let title: string;
  let caption = '';
  let count = 1;
  let counts: RegExpExecArray | null = null;
  // oginstagram's own og:image is signed and always a still, video posts
  // included; its other images are signed too, so they come from vxinstagram.
  let preview: string | null = null;
  let from = 'oginstagram';
  if (og && ogTitle) {
    title = ogTitle;
    const description = metaContent(og.html, 'og:description') ?? '';
    counts = MIRROR_PREFIX.exec(description);
    caption = description.replace(MIRROR_PREFIX, '');
    count = Number(counts?.[1] ?? 1);
    preview = metaContent(og.html, 'og:image');
  } else {
    // vxinstagram has the text too, but no image count: one image only.
    const vx = await getHtml(`https://vxinstagram.com/p/${shortcode}/`, options);
    const vxTitle = vx && metaContent(vx.html, 'og:title');
    if (!vx || !vxTitle) {
      note('[card] instagram mirrors had nothing either');
      return null;
    }
    title = vxTitle;
    caption = metaContent(vx.html, 'og:description') ?? '';
    from = 'vxinstagram';
  }
  note(`[card] instagram fell back to ${from}`);

  const canonical = `https://www.instagram.com/p/${shortcode}/`;
  const handle = /\(@([\w.]+)\)\s*$/.exec(title)?.[1] ?? '';
  const name = title.replace(/\s*\(@[\w.]+\)\s*$/, '');
  const embed: CardEmbed = {
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
  // One line, like every other card: inline fields stack on a phone.
  const stats = counts && statLine([['❤️', counts[2]], ['💬', counts[3]]]);
  const text = [caption.trim(), stats].filter(Boolean).join('\n\n');
  if (text) embed.description = toField(text, 4096);

  // An index past the end repeats the last image, so the count must come
  // from oginstagram; without it, one image is all that is safe. A video item
  // answers with an MP4, which an embed cannot show, so each is checked.
  const candidates = Array.from(
    { length: Math.min(Math.max(count, 1), MAX_EMBEDS) },
    (_, index) => (index === 0 && preview ? preview : `https://vxinstagram.com/offload/${shortcode}/${index}`),
  );
  const stills = await Promise.all(candidates.map((url) => (url === preview ? true : servesImage(url, options))));
  const images = candidates.filter((_, index) => stills[index]);
  if (images.length > 0) embed.image = { url: images[0]! };
  if (images.length > 1) embed.footer = { text: `Instagram · 1/${images.length}` };

  return {
    embeds: [
      embed,
      ...images.slice(1).map((image, index) => ({
        url: canonical,
        color: INSTAGRAM_PINK,
        image: { url: image },
        footer: { text: `Instagram · ${index + 2}/${images.length}` },
      })),
    ],
    files: [],
  };
}
