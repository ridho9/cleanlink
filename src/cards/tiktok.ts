// TikTok: its own oEmbed returns an iframe and no metadata, and the page's
// og:title is the literal string "TikTok · TikTok". tikwm.com is the fxtwitter
// of TikTok: caption, author, cover and counts.

import {
  authorBlock,
  attachMedia,
  playback,
  getJson,
  statLine,
  TIKTOK_BLACK,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

type TikTokResponse = {
  code?: number;
  data?: {
    author?: { nickname?: string; unique_id?: string; avatar?: string } | null;
    cover?: string | null;
    origin_cover?: string | null;
    play?: unknown;
    title?: string;
    create_time?: number;
    play_count?: unknown;
    digg_count?: unknown;
    comment_count?: unknown;
  } | null;
};

async function buildTikTokCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const [, handle, id] = match;
  const canonical = `https://www.tiktok.com/@${handle}/video/${id}`;

  // tikwm.com is a public API with no key, and the only source of a real
  // caption: TikTok's own oEmbed returns an iframe and nothing else.
  const data = await getJson<TikTokResponse>(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(canonical)}`,
    options,
  );
  if (data?.code !== 0 || !data.data) return null;

  const video = data.data;
  const author = video.author ?? {};
  const cover = video.cover ?? video.origin_cover;

  // tikwm's `play` is a TikTok CDN file, not a tikwm one, so it is the same
  // first-party media the platform serves - attach it like an X video.
  const play = typeof video.play === 'string' ? video.play : null;
  const played = await attachMedia(play, options);
  const playing = played.kind !== 'none';

  const embed: CardEmbed = {
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
  // Same one-line layout as every other card: inline fields stack on a phone.
  const stats = statLine([
    ['▶', video.play_count],
    ['❤️', video.digg_count],
    ['💬', video.comment_count],
  ]);
  const text = [video.title, stats].filter(Boolean).join('\n\n');
  if (text) embed.description = toField(text, 4096);
  // The cover is the fallback: when the video is attached (or queued as a
  // follow-up) the player shows its own frame.
  if (cover && !playing) embed.image = { url: cover };
  if (video.create_time) embed.timestamp = new Date(video.create_time * 1000).toISOString();

  return { embeds: [embed], ...playback(played) };
}

export { buildTikTokCard };
