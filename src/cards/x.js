// X: the fxtwitter API carries the full text, the avatar, the stats and the
// quoted tweet. Discord's own X card shows a truncated title.

import {
  authorBlock,
  clip,
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
  const media = tweet.media?.all ?? [];
  const photos = media.filter((item) => item.type === 'photo').map((item) => item.url);

  // A video tweet still gets a card, using the poster frame. Discord cannot
  // play X video either way, and the frame plus the text beats a bare link.
  const still = media.find((item) => item.thumbnail_url)?.thumbnail_url;

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

  // One embed per photo. A Discord embed has a single `image` field and a
  // single `thumbnail` field, so two images cannot share a card at full size;
  // SaucyBot solves the same limit the same way (one embed per photo in
  // `FxTwitter.cs`). The first embed carries the text, the rest are images.
  if (photos[0]) embed.image = { url: photos[0] };
  else if (still) embed.image = { url: still };
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

  // pbs.twimg.com is fetchable by Discord, so extra photos cost nothing here.
  const embeds = [embed, ...imageEmbeds(embed.url, X_BLUE, embed.footer, photos.slice(1))];

  return { embeds, files: [] };
}

export { buildXCard };
