// nhentai: the gallery page is behind a Cloudflare challenge (403 "Just a
// moment…" for every user agent), so Discord's own unfurl has nothing to show.
// The JSON API is not challenged and carries everything a card needs, and the
// cover on t.nhentai.net is fetchable by Discord without a Referer.
//
// Adult content: the card is only built for a channel Discord marks as
// age-restricted. See nsfwAllowed() in bot.js.

import {
  authorBlock,
  getJson,
  toField,
  escapeMarkdown,
  NHENTAI_RED,
} from './shared.js';

/** Tag types worth their own field, in display order. */
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

export async function buildNhentaiCard({ match, href }, options) {
  // Two gates, not one: the builder refuses on its own, and the caller decides
  // what an age-restricted channel is.
  if (!options.nsfw) return null;

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

  // No description: the English title is the same title wrapped in bracketed
  // artist, parody and language markers, all of which are fields already —
  // and every `[` needs escaping, which turns it into noise.
  if (cover) embed.image = { url: cover };
  if (data.upload_date) embed.timestamp = new Date(data.upload_date * 1000).toISOString();

  const artists = namesOf(tags, 'artist');
  const groups = namesOf(tags, 'group');
  if (artists || groups) {
    embed.author = authorBlock([artists, groups && `(${groups})`].filter(Boolean).join(' '), 'nhentai', {
      url: 'https://nhentai.net',
    });
  }

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

  if (data.scanlator) {
    fields.push({ name: 'Scanlator', value: toField(data.scanlator, 1024) });
  }

  const languages = tags
    .filter((tag) => tag?.type === 'language' && tag.name)
    .map((tag) => escapeMarkdown(tag.name))
    .slice(0, 3);
  if (languages.length > 0) {
    fields.push({ name: 'Language', value: languages.join(', '), inline: true });
  }

  for (const [type, name] of TAG_FIELDS) {
    const value = namesOf(tags, type);
    if (value) fields.push({ name, value: toField(value, 1024) });
  }

  if (fields.length > 0) embed.fields = fields;

  return { embeds: [embed], files: [] };
}
