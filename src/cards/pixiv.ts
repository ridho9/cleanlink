// Pixiv: i.pximg.net answers 403 unless the request carries a pixiv Referer,
// which Discord never sends, so the native card has no image. The pages are
// downloaded and re-uploaded instead.

import {
  authorBlock,
  clip,
  escapeMarkdown,
  extensionOf,
  getBytes,
  getJson,
  MAX_ATTACH_BYTES,
  PIXIV_BLUE,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';
import { note } from '../trace.ts';

/** Pages per work: SaucyBot's cap, so a long manga stays one predictable card. */
const MAX_PAGES = 5;

/** The mirror fetches the file itself before it answers, which measured 0.3 s
 *  warm and several seconds cold. */
const MIRROR_TIMEOUT_MS = 20_000;

type PixivIllustResponse = {
  error?: boolean;
  body?: {
    xRestrict?: number;
    userName?: string;
    userId?: string;
    illustTitle?: string;
    pageCount?: number;
    tags?: { tags?: ({ tag?: string } | null)[] } | null;
  } | null;
};

type PixivPagesResponse = {
  body?: ({ urls?: { regular?: string } | null } | null)[] | null;
};

async function buildPixivCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const [, id] = match;
  // An R-18 work is listed to anyone but its files are named only to a signed-in
  // viewer: every `urls` field is null and `ajax/illust/<id>/pages` answers 404,
  // exactly as for a work that does not exist. With a session cookie that does
  // not happen; without one the mirror below covers the work.
  const cookie = process.env.PIXIV_COOKIE;
  const headers = {
    referer: 'https://www.pixiv.net/',
    ...(cookie ? { cookie } : {}),
  };

  const meta = await getJson<PixivIllustResponse>(`https://www.pixiv.net/ajax/illust/${id}`, {
    ...options,
    headers,
  });
  if (!meta || meta.error || !meta.body) return null;

  const pages = await getJson<PixivPagesResponse>(`https://www.pixiv.net/ajax/illust/${id}/pages`, {
    ...options,
    headers,
  });
  const budget = options.budget ?? {};
  const filesLeft = Math.min(MAX_PAGES, budget.files ?? MAX_PAGES);
  const byteCap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  // An earlier card in the same message may have spent the whole file budget.
  if (filesLeft <= 0) return null;

  const restricted = (meta.body.xRestrict ?? 0) !== 0;
  const urls = (pages?.body ?? [])
    .map((page) => page?.urls?.regular)
    .filter((url): url is string => Boolean(url))
    .slice(0, filesLeft);

  // No page list, but the work has pages: read them from `pixiv.re`, which
  // serves page N of a work id and hands the file over where pixiv will not
  // (measured 2026-11-09 on artwork 151909412: every `urls` null, and both pages
  // at 1150x1600, the size in the metadata). It is read for the bytes only, the
  // way facebed is read for its tags: the message keeps the pixiv link.
  const mirrored =
    urls.length === 0 && (meta.body.pageCount ?? 0) > 0
      ? Array.from(
          { length: Math.min(meta.body.pageCount ?? 0, filesLeft) },
          (_, index) => `https://pixiv.re/${id}-${index + 1}.jpg`,
        )
      : [];
  const sources = urls.length > 0 ? urls : mirrored;

  // The whole point of this card is the image, and it only exists if we host
  // it: Discord cannot fetch i.pximg.net.
  if (sources.length === 0) {
    note(`[card] pixiv ${id}: no pages`);
    return null;
  }
  const files = [];
  let bytes = 0;
  const timeout = mirrored.length > 0 ? MIRROR_TIMEOUT_MS : options.timeout;
  // Fetched together, kept in page order: the wait is the slowest page, not
  // the sum of them.
  const buffers = await Promise.all(
    sources.map((url) => getBytes(url, { ...options, headers, ...(timeout ? { timeout } : {}) }, byteCap)),
  );
  for (const [index, url] of sources.entries()) {
    const buffer = buffers[index];
    if (!buffer) continue;
    if (bytes + buffer.length > byteCap) break;
    bytes += buffer.length;
    const name = `${restricted ? 'SPOILER_' : ''}p${index}.${extensionOf(url)}`;
    files.push({ attachment: buffer, name });
  }
  if (files.length === 0) {
    note(
      mirrored.length > 0
        ? `[card] pixiv ${id}: mirror gave no page`
        : `[card] pixiv ${id}: no page could be fetched`,
    );
    return null;
  }

  const embed: CardEmbed = {
    url: href,
    color: PIXIV_BLUE,
    author: authorBlock(meta.body.userName, 'Pixiv', {
      url: meta.body.userId && `https://www.pixiv.net/users/${meta.body.userId}`,
    }),
    title: toField(meta.body.illustTitle ?? `Pixiv ${id}`, 256),
    image: { url: `attachment://${files[0].name}` },
    footer: {
      text: restricted
        ? 'Pixiv · restricted'
        : `Pixiv · ${meta.body.pageCount ?? files.length} page(s)`,
    },
  };

  // One image per embed, same as X: the first embed carries the title and the
  // author, the rest are pages. Every file is claimed, so no loose attachment
  // is left above the card.
  const embeds = [embed];
  for (const [offset, file] of files.slice(1).entries()) {
    embeds.push({
      url: href,
      color: PIXIV_BLUE,
      image: { url: `attachment://${file.name}` },
      footer: { text: `Pixiv · page ${offset + 2}/${files.length}` },
    });
  }

  const tags = (meta.body.tags?.tags ?? [])
    .map((tag) => tag?.tag)
    .filter((tag): tag is string => Boolean(tag))
    .slice(0, 10);
  if (tags.length > 0) {
    embed.description = clip(tags.map((tag) => escapeMarkdown(tag)).join(' · '), 4096);
  }

  return { embeds, files };
}

export { buildPixivCard };
