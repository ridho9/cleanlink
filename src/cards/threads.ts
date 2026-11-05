// Threads: the page serves the post text in `og:description`, but only to a
// browser user agent — Discordbot gets a shell with no description at all.

import {
  authorBlock,
  getHtml,
  metaContent,
  THREADS_BLACK,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

/** Threads allows 20 items per carousel; Discord allows 10 embeds a message. */
const MAX_IMAGES = 10;

async function buildThreadsCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const page = await getHtml(href, options);
  if (!page) return null;

  const description = metaContent(page.html, 'og:description');
  // Without the text there is nothing this card adds over Discord's own
  // preview, which already shows the author and the image.
  if (!description) return null;

  const title = metaContent(page.html, 'og:title') ?? 'Threads';
  const author = title.replace(/\s+on Threads$/i, '').trim();
  const embed: CardEmbed = {
    url: metaContent(page.html, 'og:url') ?? href,
    color: THREADS_BLACK,
    author: authorBlock(author, 'Threads', { url: href }),
    description: toField(description, 4096),
    footer: { text: 'Threads' },
  };

  // A carousel's og:image is only its first item. The page also carries the
  // post as JSON, with every item; each one gets an embed, and embeds that
  // share a URL show as one gallery in Discord.
  const carousel = carouselImages(page.html, match[2]).slice(0, MAX_IMAGES);
  if (carousel.length > 1) {
    embed.image = { url: carousel[0]! };
    embed.footer = { text: `Threads · 1/${carousel.length}` };
    return {
      embeds: [
        embed,
        ...carousel.slice(1).map((image, index) => ({
          url: embed.url,
          color: THREADS_BLACK,
          image: { url: image },
          footer: { text: `Threads · ${index + 2}/${carousel.length}` },
        })),
      ],
      files: [],
    };
  }

  const image = metaContent(page.html, 'og:image');
  // A text-only post still has an og:image: the author's avatar, served from
  // Instagram's profile-photo bucket (type `t51.2885-19`). That belongs in the
  // corner, not across the card. Post media uses other type ids.
  if (image) {
    if (/\/t51\.2885-19\//.test(image)) embed.thumbnail = { url: image };
    else embed.image = { url: image };
  }

  return { embeds: [embed], files: [] };
}

interface ThreadsItem {
  image_versions2?: { candidates?: { url?: string }[] };
}

/**
 * The image of every carousel item of post `code`, largest rendition first in
 * each list, as embedded in the page's `application/json` scripts. A video
 * item gives its poster frame. Empty when the post is not a carousel or the
 * page shape changed: the card then falls back to og:image.
 */
function carouselImages(html: string, code: string | null | undefined): string[] {
  if (!code) return [];
  for (const [, json] of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!json!.includes(`"code":"${code}"`)) continue;
    let data: unknown;
    try {
      data = JSON.parse(json!);
    } catch {
      continue;
    }
    const post = findPost(data, code);
    if (post) {
      return post.carousel_media
        .map((item) => item.image_versions2?.candidates?.[0]?.url)
        .filter((url): url is string => Boolean(url));
    }
  }
  return [];
}

function findPost(node: unknown, code: string): { carousel_media: ThreadsItem[] } | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  if (record.code === code && Array.isArray(record.carousel_media)) {
    return record as { carousel_media: ThreadsItem[] };
  }
  for (const value of Object.values(record)) {
    const found = findPost(value, code);
    if (found) return found;
  }
  return null;
}

export { buildThreadsCard };
