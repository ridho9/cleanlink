// nhentai: the gallery page is behind a Cloudflare challenge (403 "Just a
// moment…" for every user agent), so Discord's own unfurl has nothing to show.
// The JSON API is not challenged and carries everything a card needs, and the
// cover on t.nhentai.net is fetchable by Discord without a Referer.
//
// One presentation, by request: title, author, and the cover attached as
// `SPOILER_cover.webp`. Discord cannot spoiler an embed image — the spoiler
// flag exists on attachments only — so the cover leaves the embed and the
// explicit tag list is not shown at all.

import {
  authorBlock,
  escapeMarkdown,
  getBytes,
  getJson,
  MAX_ATTACH_BYTES,
  NHENTAI_RED,
  toField,
} from './shared.js';

export async function buildNhentaiCard({ match, href }, options) {
  const data = await getJson(`https://nhentai.net/api/v2/galleries/${match[1]}`, options);
  // A missing gallery answers `{"error":"Gallery not found"}` with a 404.
  if (!data || data.error || !data.title) return null;

  const title = data.title.pretty || data.title.english || `Gallery ${match[1]}`;
  const cover = data.cover?.path ? `https://t.nhentai.net/${data.cover.path}` : null;
  const tags = data.tags ?? [];

  const embed = {
    url: href,
    color: NHENTAI_RED,
    title: toField(title, 256),
    footer: { text: 'nhentai' },
  };

  if (data.upload_date) embed.timestamp = new Date(data.upload_date * 1000).toISOString();

  const artists = tags
    .filter((tag) => tag?.type === 'artist' && tag.name)
    .map((tag) => escapeMarkdown(tag.name))
    .slice(0, 5)
    .join(', ');
  const groups = tags
    .filter((tag) => tag?.type === 'group' && tag.name)
    .map((tag) => escapeMarkdown(tag.name))
    .slice(0, 5)
    .join(', ');
  if (artists || groups) {
    embed.author = authorBlock(
      [artists, groups && `(${groups})`].filter(Boolean).join(' '),
      'nhentai',
      { url: 'https://nhentai.net' },
    );
  }

  // The cover is only useful spoiler-tagged, and only an attachment can carry
  // that flag. If the upload does not fit the message budget the card still
  // goes out, without the picture.
  const budget = options.budget ?? {};
  const filesLeft = budget.files ?? 1;
  const byteCap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  if (cover && filesLeft > 0) {
    const buffer = await getBytes(cover, options, byteCap);
    if (buffer) {
      return {
        embeds: [embed],
        files: [{ attachment: buffer, name: 'SPOILER_cover.webp' }],
      };
    }
  }

  return { embeds: [embed], files: [] };
}
