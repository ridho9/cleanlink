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
  MAX_IMAGES,
  PIXIV_BLUE,
  toField,
} from './shared.js';

async function buildPixivCard({ match, href }, options) {
  const [, id] = match;
  const headers = { referer: 'https://www.pixiv.net/' };

  const meta = await getJson(`https://www.pixiv.net/ajax/illust/${id}`, {
    ...options,
    headers,
  });
  if (!meta || meta.error || !meta.body) return null;

  const pages = await getJson(`https://www.pixiv.net/ajax/illust/${id}/pages`, {
    ...options,
    headers,
  });
  const budget = options.budget ?? {};
  const filesLeft = Math.min(MAX_IMAGES, budget.files ?? MAX_IMAGES);
  const byteCap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  // An earlier card in the same message may have spent the whole file budget.
  if (filesLeft <= 0) return null;

  const urls = (pages?.body ?? [])
    .map((page) => page?.urls?.regular)
    .filter(Boolean)
    .slice(0, filesLeft);

  // The whole point of this card is the image, and it only exists if we host
  // it: Discord cannot fetch i.pximg.net. No files means no card.
  const files = [];
  let bytes = 0;
  const restricted = (meta.body.xRestrict ?? 0) !== 0;
  for (const [index, url] of urls.entries()) {
    const buffer = await getBytes(url, { ...options, headers });
    if (!buffer) continue;
    if (bytes + buffer.length > byteCap) break;
    bytes += buffer.length;
    const name = `${restricted ? 'SPOILER_' : ''}p${index}.${extensionOf(url)}`;
    files.push({ attachment: buffer, name });
  }
  if (files.length === 0) return null;

  const embed = {
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
    .filter(Boolean)
    .slice(0, 10);
  if (tags.length > 0) {
    embed.description = clip(tags.map((tag) => escapeMarkdown(tag)).join(' · '), 4096);
  }

  return { embeds, files };
}

export { buildPixivCard };
