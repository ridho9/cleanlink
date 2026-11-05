// X: the fxtwitter API carries the full text, the avatar, the stats and the
// quoted tweet. Discord's own X card shows a truncated title.

import {
  authorBlock,
  clip,
  attachMedia,
  escapeMarkdown,
  getJson,
  imageEmbeds,
  statFields,
  toField,
  X_BLUE,
} from './shared.js';

async function buildXCard({ match, href }, options) {
  const [, handle, id] = match;
  const data = await getJson(`https://api.fxtwitter.com/${handle}/status/${id}`, options);
  if (data?.code !== 200 || !data.tweet) return null;

  const tweet = data.tweet;
  const author = tweet.author ?? {};

  // The video is fetched before the images are chosen, because a successful
  // download changes what a poster frame is worth: once the player is in the
  // message, the frame repeats the video's own first second.
  const video = videoUrls(tweet.media?.all) ?? videoUrls(tweet.quote?.media?.all);
  const { files, followUp } = await attachMedia(video, options);
  const playing = files.length > 0 || Boolean(followUp);

  // The main tweet's picture first, then the quoted tweet's. A quote can carry
  // photos of its own and they were being dropped; the API exposes them as
  // `quote.media.all`, same shape as `media.all`.
  const images = [
    ...stills(tweet.media?.all, playing),
    ...stills(tweet.quote?.media?.all, playing),
  ];

  const parts = [];
  if (tweet.text) parts.push(escapeMarkdown(tweet.text));
  if (tweet.quote?.text) {
    const quoted = tweet.quote.author ?? {};
    const who = [quoted.name, quoted.screen_name ? `(@${quoted.screen_name})` : '']
      .filter(Boolean)
      .join(' ');
    const body = tweet.quote.text
      .split('\n')
      .map((line) => `> ${escapeMarkdown(line)}`)
      .join('\n');
    parts.push(`> **Quoting ${escapeMarkdown(who)}**\n${body}`);
  }

  const embed = {
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

  // One embed per image. A Discord embed has a single `image` field and a
  // single `thumbnail` field, so two images cannot share a card at full size;
  // SaucyBot solves the same limit the same way (one embed per photo in
  // `FxTwitter.cs`). The first embed carries the text, the rest are images.
  if (images[0]) embed.image = { url: images[0] };
  if (tweet.created_timestamp) {
    embed.timestamp = new Date(tweet.created_timestamp * 1000).toISOString();
  }

  const fields = statFields([
    ['Replies', tweet.replies],
    ['Retweets', tweet.retweets],
    ['Likes', tweet.likes],
    ['Views', tweet.views],
  ]);
  if (fields) embed.fields = fields;

  // pbs.twimg.com is fetchable by Discord, so extra images cost nothing here.
  const footer = images.length > 1 ? { text: `Twitter · 1/${images.length}` } : embed.footer;
  if (images.length > 1) embed.footer = footer;

  const embeds = [
    embed,
    ...images.slice(1).map((image, index) => ({
      url: embed.url,
      color: X_BLUE,
      image: { url: image },
      footer: { text: `Twitter · ${index + 2}/${images.length}` },
    })),
  ];

  return { embeds, files, ...(followUp ? { followUp } : {}) };
}

/**
 * The MP4 renditions of the first video or GIF, best first.
 *
 * X offers several bitrates and the default one can exceed Discord's upload
 * limit; a smaller rendition is still worth attaching, so every MP4 is a
 * candidate and `downloadMedia` takes the first that fits. HLS playlists
 * (`.m3u8`) are skipped: Discord cannot play them.
 */
function videoUrls(media = []) {
  for (const item of media) {
    if (item.type !== 'video' && item.type !== 'gif') continue;

    const mp4s = (item.formats ?? [])
      .filter((format) => /\.mp4(\?|$)/.test(format.url ?? ''))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      .map((format) => format.url);

    const urls = [...new Set([item.url, ...mp4s])].filter((url) => url && /\.mp4(\?|$)/.test(url));
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
function stills(media = [], playing = false) {
  return media
    .map((item) => {
      if (item.type === 'photo') return item.url;
      return playing ? null : item.thumbnail_url;
    })
    .filter(Boolean);
}

export { buildXCard };
