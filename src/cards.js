import { extractUrls } from './clean.js';

// Preview cards for the sites where Discord's own unfurl is broken or thin.
//
// Most sites need nothing here: Threads, Instagram and Misskey already answer
// Discord's crawler with a full set of OpenGraph tags, YouTube has a native
// player, and TikTok serves an iframe-only oEmbed. Only two sites pay for
// themselves:
//
//   X      — the fxtwitter API carries the full text, the avatar, the stats
//            and the quote tweet. Discord's X card shows a truncated title.
//   Pixiv  — i.pximg.net answers 403 unless the request carries a pixiv
//            Referer, which Discord never sends, so the native card has no
//            image. We download the pages ourselves and re-upload them.
//   TikTok — its own oEmbed returns an iframe and no metadata, and the page's
//            og:title is the literal string "TikTok · TikTok". tikwm.com is
//            the fxtwitter of TikTok: real caption, author, cover and counts.
//
// Adding a site is a table entry plus a builder. Keep it that way.

const BROWSER_UA = 'Mozilla/5.0';
const TIMEOUT_MS = 6000;

// A message can carry several cards, but each one spends the same per-message
// budget that Discord enforces, so the limits below are shared, not per card.
const MAX_CARDS = 5; // mirrors the cleaner's 5-link cap
const MAX_EMBEDS = 10; // Discord's hard limit per message
const MAX_FILES = 10; // Discord's hard limit per message
const MAX_IMAGES = 5; // pages per Pixiv work, matching SaucyBot's cap
const MAX_ATTACH_BYTES = 8_000_000; // below Discord's default 10 MB limit

const X_BLUE = 0x1d9bf0;
const PIXIV_BLUE = 0x0096fa;
const TIKTOK_BLACK = 0x010101;

/** Hosts a card is allowed to ask, kept separate from the tracker rules. */
export const CARD_SITES = [
  {
    id: 'x',
    hosts: ['x.com', 'twitter.com'],
    // `i` is X's own placeholder handle for a status id, and it works here.
    match: (url) => /^\/([A-Za-z0-9_]{1,20})\/status\/(\d{1,25})/.exec(url.pathname),
    build: buildXCard,
  },
  {
    id: 'pixiv',
    hosts: ['pixiv.net'],
    match: (url) => /^\/(?:[a-z]{2}\/)?artworks\/(\d{1,12})/i.exec(url.pathname),
    build: buildPixivCard,
  },
  {
    id: 'tiktok',
    hosts: ['tiktok.com'],
    // Photo posts (/@user/photo/<id>) are not covered: tikwm's shape for them
    // is unverified, and a card built on a guess is worse than a clean link.
    match: (url) => /^\/@([\w.-]{1,64})\/video\/(\d{6,})/.exec(url.pathname),
    build: buildTikTokCard,
  },
];

// ---------------------------------------------------------------- utilities

/**
 * Neutralise Discord markdown in text we did not write.
 *
 * Escaping runs before clipping so a truncated string can never end on a lone
 * backslash that would swallow the character after it.
 */
export function escapeMarkdown(text) {
  return String(text ?? '')
    .replace(/([\\`*_~|[])/g, '\\$1')
    .replace(/^(\s*)([>#+-])/gm, '$1\\$2')
    .replace(/^(\s*)(\d+)\./gm, '$1$2\\.');
}

/**
 * Fit already-safe text into a Discord field, whose limits are counted in
 * characters of the final string.
 *
 * Compose first, clip last: escaping a string that already contains our own
 * `> **Quoting …**` markup would neutralise the markup itself.
 */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // A trailing backslash means the cut landed inside an escape sequence.
  return `${cut.endsWith('\\') ? cut.slice(0, -1) : cut}…`;
}

/** Escape free text from a third party, then fit it into a field. */
export function toField(text, max) {
  return clip(escapeMarkdown(text), max);
}

function hostMatches(host, list) {
  return list.some((base) => host === base || host.endsWith(`.${base}`));
}

async function getJson(url, { fetchImpl, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getBytes(url, { fetchImpl, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return null;
  return buffer;
}

/** Guess an extension from a URL path, defaulting to jpg. */
function extensionOf(url) {
  const path = new URL(url).pathname.toLowerCase();
  const match = /\.(jpg|jpeg|png|gif|webp)$/.exec(path);
  return match ? match[1].replace('jpeg', 'jpg') : 'jpg';
}

// ---------------------------------------------------------------------- X

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
    author: {
      name: toField(
        [author.name, author.screen_name ? `(@${author.screen_name})` : '']
          .filter(Boolean)
          .join(' ') || 'X',
        256,
      ),
    },
    footer: { text: 'Twitter' },
  };

  if (author.url) embed.author.url = author.url;
  if (author.avatar_url) embed.author.icon_url = author.avatar_url;
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

  const stats = [
    ['Replies', tweet.replies],
    ['Retweets', tweet.retweets],
    ['Likes', tweet.likes],
    ['Views', tweet.views],
  ].filter(([, value]) => Number.isFinite(value));

  if (stats.length > 0) {
    embed.fields = stats.map(([name, value]) => ({
      name,
      value: value.toLocaleString('en-US'),
      inline: true,
    }));
  }

  // pbs.twimg.com is fetchable by Discord, so extra photos cost nothing here.
  const embeds = [embed];
  for (const url of photos.slice(1)) {
    embeds.push({ url: embed.url, color: X_BLUE, image: { url }, footer: embed.footer });
  }

  return { embeds, files: [] };
}

// ------------------------------------------------------------------ TikTok

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
    author: {
      name: toField(
        [author.nickname, author.unique_id ? `(@${author.unique_id})` : '']
          .filter(Boolean)
          .join(' ') || 'TikTok',
        256,
      ),
      url: author.unique_id ? `https://www.tiktok.com/@${author.unique_id}` : canonical,
    },
    footer: { text: 'TikTok' },
  };

  if (author.avatar) embed.author.icon_url = author.avatar;
  if (video.title) embed.description = toField(video.title, 4096);
  // A video cannot play in a Discord embed, so the cover stands in for it.
  if (cover) embed.image = { url: cover };
  if (video.create_time) embed.timestamp = new Date(video.create_time * 1000).toISOString();

  const stats = [
    ['Plays', video.play_count],
    ['Likes', video.digg_count],
    ['Comments', video.comment_count],
  ].filter(([, value]) => Number.isFinite(value));

  if (stats.length > 0) {
    embed.fields = stats.map(([name, value]) => ({
      name,
      value: value.toLocaleString('en-US'),
      inline: true,
    }));
  }

  return { embeds: [embed], files: [] };
}

// ------------------------------------------------------------------- Pixiv

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
    author: { name: toField(meta.body.userName ?? 'Pixiv', 256) },
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

  if (meta.body.userId) embed.author.url = `https://www.pixiv.net/users/${meta.body.userId}`;

  const tags = (meta.body.tags?.tags ?? [])
    .map((tag) => tag?.tag)
    .filter(Boolean)
    .slice(0, 10);
  if (tags.length > 0) {
    embed.description = clip(tags.map((tag) => escapeMarkdown(tag)).join(' · '), 4096);
  }

  return { embeds, files };
}

// ------------------------------------------------------------------ facade

/**
 * Build preview cards for the links in a message.
 *
 * @param {string} text raw message content
 * @param {object} [options]
 * @param {Array<{from: string, to: string}>} [options.cleaned] results from
 *   cleanMessage, so a card can show the cleaned URL rather than the tracked one
 * @returns {Promise<Array<{from: string, url: string, embeds: Array, files: Array}>>}
 */
export async function buildCards(text, { cleaned = [], fetchImpl = fetch, limit = MAX_CARDS } = {}) {
  const cleanedFor = new Map(cleaned.map(({ from, to }) => [from, to]));
  const seen = new Set();
  const cards = [];

  // Shared across every card in this message, because Discord counts them per
  // message and a rejected payload would cost the whole reply.
  let filesLeft = MAX_FILES;
  let bytesLeft = MAX_ATTACH_BYTES;
  let embedsLeft = MAX_EMBEDS;

  for (const raw of extractUrls(text)) {
    if (cards.length >= limit) break;

    // The cleaned URL comes first: a shortener was resolved into the real
    // target there, and that target is what carries the id a card needs.
    let url = null;
    let site = null;
    let match = null;
    for (const href of [cleanedFor.get(raw), raw]) {
      if (!href) continue;
      let parsed;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const found = CARD_SITES.find((candidate) =>
        hostMatches(parsed.hostname.toLowerCase(), candidate.hosts),
      );
      const foundMatch = found?.match(parsed);
      if (!foundMatch) continue;
      url = parsed;
      site = found;
      match = foundMatch;
      break;
    }
    if (!url) continue;

    const key = `${site.id}:${match.slice(1).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const card = await site.build(
        { match, href: url.href },
        { fetchImpl, budget: { files: filesLeft, bytes: bytesLeft } },
      );
      if (!card) continue;

      // A card is taken whole or not at all: a card with half its pages looks
      // broken, and Discord rejects the whole message past ten embeds.
      if (card.embeds.length > embedsLeft || card.files.length > filesLeft) continue;

      cards.push({ from: raw, url: cleanedFor.get(raw) ?? url.href, ...card });
      embedsLeft -= card.embeds.length;
      filesLeft -= card.files.length;
      bytesLeft -= card.files.reduce((total, file) => total + file.attachment.length, 0);
    } catch {
      // A card is decoration. Any failure leaves the plain cleaned reply.
    }
  }

  return cards;
}
