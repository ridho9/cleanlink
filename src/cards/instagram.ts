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

import {
  attachMedia,
  authorBlock,
  getHtml,
  getJson,
  INSTAGRAM_PINK,
  metaContent,
  toField,
  videoLinks,
} from './shared.ts';
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

/** Instagram allows 20 images per carousel; Discord allows 10 embeds a message. */
const MAX_IMAGES = 10;

export async function buildInstagramCard(
  { href }: CardInput,
  options: CardOptions,
): Promise<BuiltCard | null> {
  const url = new URL(href);
  const shortcode = url.pathname.split('/').filter(Boolean).pop();
  const [page, embedPage, oembed] = await Promise.all([
    getHtml(href, options),
    getHtml(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, options),
    getJson<InstagramOEmbed>(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(href)}`, options),
  ]);

  // The handler's own URL is only a fallback: an embed-only answer still has a
  // usable caption.
  const source = page?.html ?? embedPage?.html;
  if (!source) return null;

  const title = metaContent(source, 'og:title');
  if (!title) return null;

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

  if (caption.trim()) embed.description = toField(caption.trim(), 4096);
  if (counts) {
    embed.fields = [
      { name: 'Likes', value: counts[1], inline: true },
      { name: 'Comments', value: counts[2], inline: true },
    ];
  }

  // Fetched before the frame is chosen: once the player is in the message, the
  // frame only repeats the video's first second.
  const media = embedMedia(embedPage?.html ?? '');
  // Some reels - seen with licensed music - are marked as video in the payload
  // but carry no `video_url`. yt-dlp still resolves the same CDN file.
  const video = media.video ?? (media.isVideo ? await videoLinks(href, options) : null);
  const { files, followUp } = await attachMedia(video, options);
  const playing = files.length > 0 || Boolean(followUp);

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

  return { embeds, files, ...(followUp ? { followUp } : {}) };
}

/**
 * Every image of the post, best source first.
 *
 * A carousel's own `display_url` list is the only complete one. Otherwise the
 * oEmbed thumbnail keeps the aspect ratio (640×800 rather than a 640×640 crop)
 * and carries no play button, and `og:image` is the last resort.
 */
function imagesFor(media: InstagramMedia, source: string, oembed: InstagramOEmbed | null): string[] {
  const carousel = media.images.slice(0, MAX_IMAGES);
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
