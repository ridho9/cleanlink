// nhentai: the gallery page is behind a Cloudflare challenge (403 "Just a
// moment…" for every user agent), so Discord's own unfurl has nothing to show.
// The JSON API is not challenged and carries everything a card needs, and the
// cover on t.nhentai.net is fetchable by Discord without a Referer.
//
// Adult content, so there are two presentations:
//   full    — age-restricted channel: cover as the embed image, explicit tags.
//   spoiler — anywhere else, if the caller allows it: title, author and counts
//             only, with the cover attached under Discord's `SPOILER_` prefix.
//             Discord has no spoiler for embed images; only an attachment can
//             be hidden until clicked, so the image leaves the embed.
// If neither is allowed the builder returns nothing.

import {
  authorBlock,
  escapeMarkdown,
  getBytes,
  getJson,
  MAX_ATTACH_BYTES,
  NHENTAI_RED,
  toField,
} from './shared.js';

/** Tag types worth their own field in the full card, in display order. */
const TAG_FIELDS = [
  ['artist', 'Artists'],
  ['group', 'Groups'],
  ['parody', 'Parodies'],
  ['character', 'Characters'],
  ['tag', 'Tags'],
];

const MAX_TAGS = 12;

function namesOf(tags, type, limit = MAX_TAGS) {
  return tags
    .filter((tag) => tag?.type === type && tag.name)
    .map((tag) => escapeMarkdown(tag.name))
    .slice(0, limit)
    .join(', ');
}

/** Counts and language: the same in both presentations. */
function coreFields(data) {
  const fields = [];
  if (Number.isFinite(data.num_pages)) {
    fields.push({ name: 'Pages', value: String(data.num_pages), inline: true });
  }
  if (Number.isFinite(data.num_favorites)) {
    fields.push({
      name: 'Favorites',
      value: data.num_favorites.toLocaleString('en-US'),
      inline: true,
    });
  }

  const languages = (data.tags ?? [])
    .filter((tag) => tag?.type === 'language' && tag.name)
    .map((tag) => escapeMarkdown(tag.name))
    .slice(0, 3);
  if (languages.length > 0) {
    fields.push({ name: 'Language', value: languages.join(', '), inline: true });
  }

  return fields;
}

export async function buildNhentaiCard({ match, href }, options) {
  const full = Boolean(options.nsfw);
  if (!full && !options.spoiler) return null;

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
    footer: { text: full ? 'nhentai' : 'nhentai · spoiler' },
  };

  if (data.upload_date) embed.timestamp = new Date(data.upload_date * 1000).toISOString();

  const artists = namesOf(tags, 'artist');
  const groups = namesOf(tags, 'group');
  if (artists || groups) {
    embed.author = authorBlock(
      [artists, groups && `(${groups})`].filter(Boolean).join(' '),
      'nhentai',
      { url: 'https://nhentai.net' },
    );
  }

  const fields = coreFields(data);
  if (data.scanlator) {
    fields.push({ name: 'Scanlator', value: toField(data.scanlator, 1024) });
  }

  // The tag list is the explicit part, so the spoiler card drops it entirely.
  if (full) {
    for (const [type, name] of TAG_FIELDS) {
      const value = namesOf(tags, type);
      if (value) fields.push({ name, value: toField(value, 1024) });
    }
  }

  if (fields.length > 0) embed.fields = fields;

  if (full) {
    if (cover) embed.image = { url: cover };
    return { embeds: [embed], files: [] };
  }

  // Spoiler card: the cover becomes an attachment, which is the only Discord
  // surface that honours a spoiler. No image in the embed, or the picture
  // would show in full.
  const budget = options.budget ?? {};
  if (!cover || (budget.files ?? 1) <= 0) return { embeds: [embed], files: [] };

  const buffer = await getBytes(cover, options);
  if (!buffer || buffer.length > Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES)) {
    return { embeds: [embed], files: [] };
  }

  return {
    embeds: [embed],
    files: [{ attachment: buffer, name: 'SPOILER_cover.webp' }],
  };
}
