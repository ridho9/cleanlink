// X: the fxtwitter API carries the full text, the avatar, the stats and the
// quoted tweet. Discord's own X card shows a truncated title.

import {
  authorBlock,
  clip,
  attachMedia,
  galleryFiles,
  playback,
  escapeMarkdown,
  getJson,
  numberedEmbeds,
  statLine,
  X_BLUE,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

type XAuthor = {
  name?: string;
  screen_name?: string;
  url?: string;
  avatar_url?: string;
};

type XMedia = {
  type?: string;
  url?: string;
  thumbnail_url?: string;
  formats?: { url?: string; bitrate?: number }[];
};

type XTweet = {
  id?: string;
  text?: string;
  lang?: string;
  author?: XAuthor | null;
  media?: { all?: XMedia[] } | null;
  quote?: XTweet | null;
  created_timestamp?: number;
  replies?: unknown;
  retweets?: unknown;
  likes?: unknown;
  views?: unknown;
  translation?: XTranslation | null;
};

type XTranslation = {
  text?: string;
  source_lang?: string;
  target_lang?: string;
};

type XResponse = { code?: number; tweet?: XTweet | null };

// fixupx and the vxtwitter hosts take `/status/<id>/<language>`, X takes
// `?lang=<language>`, and people type `?<language>`. A two-letter code is the
// only form all three produce.
const LANGUAGE_TAIL = /\/status\/\d+\/([a-z]{2})$/i;
const LANGUAGE_CODE = /^[a-z]{2}$/i;

/** The language the posted URL asks for, if it asks for one. */
function askedLanguage(raw: string | undefined): string | null {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const tail = LANGUAGE_TAIL.exec(url.pathname)?.[1];
  if (tail) return tail.toLowerCase();
  const named = url.searchParams.get('lang');
  if (named && LANGUAGE_CODE.test(named)) return named.toLowerCase();
  // `?en` puts the language in the name, with an empty value.
  for (const name of url.searchParams.keys()) {
    if (LANGUAGE_CODE.test(name)) return name.toLowerCase();
  }
  return null;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** "Korean" for `ko`; null when the code names no language. */
function languageName(code: string | undefined): string | null {
  const base = (code ?? '').split('-')[0]!.toLowerCase();
  if (!LANGUAGE_CODE.test(base)) return null;
  let name;
  try {
    name = languageNames.of(base);
  } catch {
    return null;
  }
  // An unknown code comes back unchanged, and a bare code is no label.
  return name && name.toLowerCase() !== base ? name : null;
}

/**
 * The translation in the language the link asked for, when the payload has it.
 *
 * The endpoint takes the language as a path segment — `/<handle>/status/<id>/en`
 * — and answers with the post plus its `translation`, in one request. That is
 * the same text X shows behind its own "Show translation" button: the payload
 * names the source in `provider`, `grok` or `bing`. A two-letter tail is what
 * fixupx and `?lang=` both mean. Measured 2026-11-18.
 */
function matching(
  translation: XTranslation | null | undefined,
  language: string | null,
  original: string | undefined,
) {
  if (!language || !translation?.text) return null;
  // A stale answer for another language is not what the link asked for.
  const target = (translation.target_lang ?? '').split('-')[0]!.toLowerCase();
  if (target !== language) return null;
  // An unknown language code comes back as the source text unchanged: the
  // provider has no translation, and the copy is not worth printing twice.
  return translation.text.trim() === (original ?? '').trim() ? null : translation;
}

async function buildXCard({ match, raw }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const [, handle, id] = match;
  const asked = askedLanguage(raw);
  const data = await getJson<XResponse>(
    `https://api.fxtwitter.com/${handle}/status/${id}${asked ? `/${asked}` : ''}`,
    options,
  );
  if (data?.code !== 200 || !data.tweet) return null;

  const tweet = data.tweet;
  const author = tweet.author ?? {};

  // The video is fetched before the images are chosen, because a successful
  // download changes what a poster frame is worth: once the player is in the
  // message, the frame repeats the video's own first second.
  const video = videoUrls(tweet.media?.all) ?? videoUrls(tweet.quote?.media?.all);
  const played = await attachMedia(video, options);
  const playing = played.kind !== 'none';

  // The main tweet's picture first, then the quoted tweet's. A quote can carry
  // photos of its own and they were being dropped; the API exposes them as
  // `quote.media.all`, same shape as `media.all`.
  const mainImages = stills(tweet.media?.all, playing);
  const quoteImages = stills(tweet.quote?.media?.all, playing);
  const images = [...mainImages, ...quoteImages];

  // The translation first: a reader asked for this post in their language, so
  // it is the copy to read, and the original follows as the source. The label
  // names the source language, so the two lines are not mistaken for each
  // other when they look alike.
  const parts = [];
  const translated = matching(tweet.translation, asked, tweet.text);
  if (translated) {
    const source = languageName(translated.source_lang ?? tweet.lang);
    const body = escapeMarkdown(translated.text!);
    parts.push(source ? `🌐 **Translated from ${source}**\n${body}` : `🌐 ${body}`);
  }
  if (tweet.text) parts.push(escapeMarkdown(tweet.text));
  // A quote gets the same treatment, and the same order, inside its block: a
  // quoted post in another language arrives translated when the API has it
  // (measured 2026-11-18 on a Japanese quote), and the original follows.
  if (tweet.quote?.text) {
    const quoted = tweet.quote.author ?? {};
    const who = [quoted.name, quoted.screen_name ? `(@${quoted.screen_name})` : '']
      .filter(Boolean)
      .join(' ');
    const quoteTranslation = matching(tweet.quote.translation, asked, tweet.quote.text);
    const blocks = [];
    if (quoteTranslation) {
      const source = languageName(quoteTranslation.source_lang ?? tweet.quote.lang);
      const body = escapeMarkdown(quoteTranslation.text!);
      blocks.push(source ? `🌐 **Translated from ${source}**\n${body}` : `🌐 ${body}`);
    }
    blocks.push(escapeMarkdown(tweet.quote.text));
    const body = blocks
      .join('\n\n')
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
    parts.push(`> **Quoting ${escapeMarkdown(who)}**\n${body}`);
  }

  // One line of icon and number, not four inline fields: Discord keeps the
  // fields in a row on the desktop client but stacks them one per row on a
  // phone, which made the card four lines longer there. This line reads the
  // same at either width, and the mirrors print their counts the same way.
  const stats = statLine([
    ['💬', tweet.replies],
    ['🔁', tweet.retweets],
    ['❤️', tweet.likes],
    ['👁', tweet.views],
  ]);
  if (stats) parts.push(stats);

  const embed: CardEmbed = {
    url: `https://x.com/${author.screen_name ?? handle}/status/${tweet.id ?? id}`,
    color: X_BLUE,
    author: authorBlock(
      [author.name, author.screen_name ? `(@${author.screen_name})` : '']
        .filter(Boolean)
        .join(' '),
      'X',
      { url: author.url, iconUrl: author.avatar_url },
    ),
    footer: { text: 'Twitter' },
  };

  if (parts.length > 0) embed.description = clip(parts.join('\n\n'), 4096);

  // More than four pictures go as attachments, not image embeds: the client
  // lays files out in post order, and the reply layer sends them in batches of
  // ten with this card on the last batch. Up to four keep the embed layout,
  // where each picture is a full-size embed and nothing is uploaded.
  //
  // One embed per image is the fallback for that: a Discord embed has a single
  // `image` field, so two pictures cannot share an embed; SaucyBot splits them
  // the same way (`FxTwitter.cs`).
  const gallery = images.length > 4;
  if (!gallery && images[0]) embed.image = { url: images[0] };
  if (tweet.created_timestamp) {
    embed.timestamp = new Date(tweet.created_timestamp * 1000).toISOString();
  }
  if (!gallery && images.length > 1) embed.footer = { text: `Twitter · 1/${images.length}` };

  const playedCard = playback(played);
  if (gallery) {
    // An attached video is the first file; the pictures follow in post order,
    // named after their source so the quoted post's pictures are recognisable.
    const pictures = await galleryFiles([
      ...mainImages.map((url, index) => ({ url, name: `photo${index + 1}` })),
      ...quoteImages.map((url, index) => ({ url, name: `quote${index + 1}` })),
    ], options);
    return {
      embeds: [embed],
      ...playedCard,
      files: [...playedCard.files, ...pictures],
      gallery: true,
      galleryPictures: pictures.length,
    };
  }

  const embeds = [
    embed,
    ...numberedEmbeds(embed.url, X_BLUE, images, (position, total) => `Twitter · ${position}/${total}`),
  ];
  return { embeds, ...playedCard };
}

/**
 * The MP4 renditions of the first video or GIF, best first.
 *
 * X offers several bitrates and the default one can exceed Discord's upload
 * limit; a smaller rendition is still worth attaching, so every MP4 is a
 * candidate and `downloadMedia` takes the first that fits. HLS playlists
 * (`.m3u8`) are skipped: Discord cannot play them.
 */
function videoUrls(media: XMedia[] = []): string[] | null {
  for (const item of media) {
    if (item.type !== 'video' && item.type !== 'gif') continue;

    const mp4s = (item.formats ?? [])
      .filter((format) => /\.mp4(\?|$)/.test(format.url ?? ''))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      .map((format) => format.url);

    const urls = [...new Set([item.url, ...mp4s])].filter((url): url is string => Boolean(url) && /\.mp4(\?|$)/.test(url ?? ''));
    if (urls.length > 0) return urls;
  }
  return null;
}

/**
 * Every image in a media list, full size.
 *
 * A photo contributes its `url`. A video or GIF contributes its poster frame
 * only while the video itself is not attached — the frame is the fallback for
 * when Discord cannot be handed the file, not a second copy of it.
 */
function stills(media: XMedia[] = [], playing = false): string[] {
  return media
    .map((item) => {
      if (item.type === 'photo') return item.url;
      return playing ? null : item.thumbnail_url;
    })
    .filter((url): url is string => Boolean(url));
}

export { buildXCard };
