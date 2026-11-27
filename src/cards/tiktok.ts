// Tikwm supplies the rich card. TikTok's own oEmbed only returns an iframe.

import { note } from '../trace.ts';
import {
  authorBlock,
  attachMedia,
  downloadVideoWithMetadata,
  getJson,
  playback,
  statLine,
  TIKTOK_BLACK,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions, Media } from './shared.ts';

// Keep the 12 s tikwm window: replies have taken 10.2 s. The CDN transfer or
// yt-dlp uses the rest of the same 18 s deadline (6 s after a tikwm timeout).
const TIKWM_TIMEOUT_MS = 12_000;
const TIKTOK_TIMEOUT_MS = 18_000;

type TikTokResponse = {
  code?: number;
  data?: TikTokVideo | null;
};

type TikTokVideo = {
  author?: { nickname?: string; unique_id?: string; avatar?: string } | null;
  cover?: string | null;
  origin_cover?: string | null;
  play?: unknown;
  title?: string;
  create_time?: number;
  play_count?: unknown;
  digg_count?: unknown;
  comment_count?: unknown;
};

async function buildTikTokCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const [, handle, id] = match;
  const canonical = `https://www.tiktok.com/@${handle}/video/${id}`;
  const signal = AbortSignal.timeout(TIKTOK_TIMEOUT_MS);
  const bounded = { ...options, signal };
  try {
    const card = await fromTikwm(href, canonical, bounded);
    if (card) return card;
  } catch {
    // A failed request or body read must not prevent the fallback.
  }
  return fromYtDlp(href, canonical, handle!, bounded);
}

async function fromTikwm(href: string, canonical: string, options: CardOptions & { signal: AbortSignal }) {
  const data = await getJson<TikTokResponse>(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(canonical)}`,
    {
      fetchImpl: options.fetchImpl,
      headers: options.headers,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(TIKWM_TIMEOUT_MS)]),
    },
  );
  if (data?.code !== 0 || !data.data) return null;

  const video = data.data;
  const play = typeof video.play === 'string' ? video.play : null;
  // tikwm points to TikTok's own CDN, so try its video before using the cover.
  const played = await attachMedia(play, options);
  return videoCard(href, canonical, video, played);
}

async function fromYtDlp(href: string, canonical: string, handle: string, options: CardOptions & { signal: AbortSignal }) {
  let outcome: string;
  let card: BuiltCard | null = null;
  try {
    // Download natively. Raw format URLs from yt-dlp may return 403 to fetch.
    const { files, info } = await downloadVideoWithMetadata(canonical, options, 'best[protocol=https][ext=mp4]');
    const cover = typeof info?.thumbnail === 'string' && /^https?:\/\//.test(info.thumbnail) ? info.thumbnail : undefined;
    if (files || cover || info?.title || info?.channel || info?.uploader) {
      const name = info?.channel || info?.uploader;
      card = videoCard(href, canonical, {
        author: { nickname: name !== handle ? name : undefined, unique_id: handle },
        title: info?.title,
        cover,
      }, files ? { kind: 'attached', files } : { kind: 'none' });
    }
    outcome = files ? 'attached video' : card ? 'metadata only' : 'no preview';
  } catch (error) {
    outcome = options.signal.aborted ? 'deadline exhausted'
      : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'yt-dlp not found' : 'no preview';
  }
  note(`[card] tiktok yt-dlp fallback: ${outcome} for ${canonical}`);
  return card;
}

function videoCard(href: string, canonical: string, video: TikTokVideo, played: Media): BuiltCard | null {
  const author = video.author ?? {};
  const cover = video.cover ?? video.origin_cover;
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
  if (!playing && !cover && !text && !author.nickname && !author.unique_id) return null;
  if (text) embed.description = toField(text, 4096);
  // The cover is the fallback: when the video is attached (or queued as a
  // follow-up) the player shows its own frame.
  if (cover && !playing) embed.image = { url: cover };
  if (video.create_time) embed.timestamp = new Date(video.create_time * 1000).toISOString();

  return { embeds: [embed], ...playback(played) };
}

export { buildTikTokCard };
