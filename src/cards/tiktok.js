// TikTok: its own oEmbed returns an iframe and no metadata, and the page's
// og:title is the literal string "TikTok · TikTok". tikwm.com is the fxtwitter
// of TikTok: caption, author, cover and counts.

import {
  authorBlock,
  getJson,
  statFields,
  TIKTOK_BLACK,
  toField,
} from './shared.js';

async function buildTikTokCard({ match, href }, options) {
  const [, handle, id] = match;
  const canonical = `https://www.tiktok.com/@${handle}/video/${id}`;

  // tikwm.com is a public API with no key, and the only source of a real
  // caption: TikTok's own oEmbed returns an iframe and nothing else.
  const data = await getJson(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(canonical)}`,
    options,
  );
  if (data?.code !== 0 || !data.data) return null;

  const video = data.data;
  const author = video.author ?? {};
  const cover = video.cover ?? video.origin_cover;

  const embed = {
    url: href,
    color: TIKTOK_BLACK,
    author: authorBlock(
      [author.nickname, author.unique_id ? `(@${author.unique_id})` : '']
        .filter(Boolean)
        .join(' '),
      'TikTok',
      {
        url: author.unique_id ? `https://www.tiktok.com/@${author.unique_id}` : canonical,
        iconUrl: author.avatar,
      },
    ),
    footer: { text: 'TikTok' },
  };
  if (video.title) embed.description = toField(video.title, 4096);
  // A video cannot play in a Discord embed, so the cover stands in for it.
  if (cover) embed.image = { url: cover };
  if (video.create_time) embed.timestamp = new Date(video.create_time * 1000).toISOString();

  const fields = statFields([
    ['Plays', video.play_count],
    ['Likes', video.digg_count],
    ['Comments', video.comment_count],
  ]);
  if (fields) embed.fields = fields;

  return { embeds: [embed], files: [] };
}

export { buildTikTokCard };
