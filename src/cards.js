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
//
// Adding a site is a table entry plus a builder. Keep it that way.

const BROWSER_UA = 'Mozilla/5.0';
const TIMEOUT_MS = 6000;

// A message can carry several cards, but each one spends the same per-message
// budget that Discord enforces, so the limits below are shared, not per card.
// Every card emits exactly one embed, so the card cap keeps the total well
// under Discord's ten-embed limit; files and bytes are what actually bind.
const MAX_CARDS = 5; // mirrors the cleaner's 5-link cap
const MAX_FILES = 10; // Discord's hard limit per message
const MAX_IMAGES = 5; // pages per Pixiv work, matching SaucyBot's cap
const MAX_ATTACH_BYTES = 8_000_000; // below Discord's default 10 MB limit

const X_BLUE = 0x1d9bf0;
const PIXIV_BLUE = 0x0096fa;

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

  // One embed holds two images: the first large, the second as the thumbnail.
  // Discord can fetch pbs.twimg.com directly, so neither costs an upload.
  if (photos[0]) embed.image = { url: photos[0] };
  else if (still) embed.image = { url: still };
  if (photos[1]) embed.thumbnail = { url: photos[1] };
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

  // A post with three or more photos keeps the extras as attachments rather
  // than dropping them; an embed has room for exactly two images.
  const budget = options.budget ?? {};
  const files = [];
  let bytes = 0;
  const byteCap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  const filesLeft = budget.files ?? MAX_FILES;
  for (const [index, url] of photos.slice(2).entries()) {
    if (files.length >= filesLeft) break;
    const buffer = await getBytes(url, options);
    if (!buffer) continue;
    if (bytes + buffer.length > byteCap) break;
    bytes += buffer.length;
    files.push({ attachment: buffer, name: `photo${index + 3}.${extensionOf(url)}` });
  }

  return { embeds: [embed], files };
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

  // One card per work: the first page is the image, the second is the
  // thumbnail, and any further pages stay attached below it. An embed has room
  // for exactly two images, and a card per page read as three artefacts.
  if (files[1]) embed.thumbnail = { url: `attachment://${files[1].name}` };

  if (meta.body.userId) embed.author.url = `https://www.pixiv.net/users/${meta.body.userId}`;

  const tags = (meta.body.tags?.tags ?? [])
    .map((tag) => tag?.tag)
    .filter(Boolean)
    .slice(0, 10);
  if (tags.length > 0) {
    embed.description = clip(tags.map((tag) => escapeMarkdown(tag)).join(' · '), 4096);
  }

  return { embeds: [embed], files };
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

  for (const raw of extractUrls(text)) {
    if (cards.length >= limit) break;

    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (!hostMatches(url.hostname.toLowerCase(), CARD_SITES.flatMap((s) => s.hosts))) continue;

    const site = CARD_SITES.find((candidate) =>
      hostMatches(url.hostname.toLowerCase(), candidate.hosts),
    );
    const match = site?.match(url);
    if (!match) continue;

    const key = `${site.id}:${match.slice(1).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const card = await site.build(
        { match, href: cleanedFor.get(raw) ?? url.href },
        { fetchImpl, budget: { files: filesLeft, bytes: bytesLeft } },
      );
      if (!card) continue;

      cards.push({ from: raw, url: cleanedFor.get(raw) ?? url.href, ...card });
      filesLeft -= card.files.length;
      bytesLeft -= card.files.reduce((total, file) => total + file.attachment.length, 0);
    } catch {
      // A card is decoration. Any failure leaves the plain cleaned reply.
    }
  }

  return cards;
}
