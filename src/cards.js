import { extractUrls, hostMatches } from './clean.js';

// Preview cards for the sites where Discord's own unfurl is broken or thin.
//
// Most sites need nothing here: Instagram and Misskey already answer Discord's
// crawler with a full set of OpenGraph tags, and YouTube has a native player.
// Five sites pay for themselves:
//
//   X        — the fxtwitter API carries the full text, the avatar, the stats
//              and the quote tweet. Discord's X card shows a truncated title.
//   Pixiv    — i.pximg.net answers 403 unless the request carries a pixiv
//              Referer, which Discord never sends, so the native card has no
//              image. We download the pages ourselves and re-upload them.
//   Threads  — the page serves a full set of OpenGraph tags INCLUDING the post
//              text, but only to a browser user agent. Discord crawls as
//              Discordbot, gets a 107 KB shell with no og:description, and
//              shows a card with an author and no words. One fetch with
//              Mozilla/5.0 fixes that; no browser engine is involved.
//   Facebook — the post page is a login wall, but the public embed iframe at
//              /plugins/post.php is not: it returns the author, the post text
//              and the media for any post that allows embedding. It answers
//              "unavailable" for posts that do not, which is simply no card.
//   TikTok   — its own oEmbed returns an iframe and no metadata, and the page's
//              og:title is the literal string "TikTok · TikTok". tikwm.com is
//              the fxtwitter of TikTok: caption, author, cover and counts.
//
// Adding a site is a table entry plus a builder. Keep it that way.

// Meta serves Threads metadata to a browser string and an empty shell to
// Discordbot, so the Threads builder must not borrow this for a crawler UA.
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
const THREADS_BLACK = 0x000000;
const FACEBOOK_BLUE = 0x1877f2;

/** Sites that own a card, kept separate from the tracker rules in rules.js. */
const CARD_SITES = [
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
    id: 'threads',
    hosts: ['threads.com', 'threads.net'],
    match: (url) => /^\/@([\w.]{1,64})\/post\/([A-Za-z0-9_-]{6,})/.exec(url.pathname),
    build: buildThreadsCard,
  },
  {
    id: 'facebook',
    hosts: ['facebook.com', 'fb.com', 'fb.watch'],
    // Permalinks, reels and watch links all answer on the embed endpoint.
    // A /share/ link resolves into one of these before the card is built.
    match: (url) =>
      /^\/[^/]+\/posts\/([0-9]{6,}|pfbid[0-9A-Za-z]{10,})/.exec(url.pathname) ??
      /^\/reel\/(\d{6,})/.exec(url.pathname) ??
      /^\/[^/]+\/videos\/(\d{6,})/.exec(url.pathname) ??
      (/^\/watch\/?$/.test(url.pathname) && url.searchParams.get('v')
        ? ['watch', url.searchParams.get('v')]
        : null) ??
      (/^\/permalink\.php$/.test(url.pathname) && url.searchParams.get('story_fbid')
        ? ['permalink']
        : null),
    build: buildFacebookCard,
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
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // A trailing backslash means the cut landed inside an escape sequence.
  return `${cut.endsWith('\\') ? cut.slice(0, -1) : cut}…`;
}

/** Escape free text from a third party, then fit it into a field. */
export function toField(text, max) {
  return clip(escapeMarkdown(text), max);
}

/** One request, with the headers and timeout every builder needs. */
function request(url, { fetchImpl = fetch, accept, headers = {} } = {}) {
  return fetchImpl(url, {
    headers: {
      'user-agent': BROWSER_UA,
      ...(accept ? { accept } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function getJson(url, options) {
  const res = await request(url, { ...options, accept: 'application/json' });
  if (!res.ok) return null;
  return res.json();
}

async function getHtml(url, options) {
  const res = await request(url, { ...options, accept: 'text/html' });
  if (!res.ok) return null;
  return { status: res.status, html: await res.text() };
}

async function getBytes(url, options) {
  const res = await request(url, options);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return null;
  return buffer;
}

/**
 * The stats block every card ends with.
 * @param {Array<[string, unknown]>} entries name/value pairs; a pair is dropped
 *   when its value is not a number
 */
function statFields(entries) {
  const rows = entries.filter(([, value]) => Number.isFinite(value));
  if (rows.length === 0) return null;
  return rows.map(([name, value]) => ({
    name,
    value: value.toLocaleString('en-US'),
    inline: true,
  }));
}

/** Image-only embeds: every image after the first on a card gets one. */
function imageEmbeds(url, color, footer, images) {
  return images.map((image) => ({ url, color, footer, image: { url: image } }));
}

/** The author block, with whichever of its two optional fields exist. */
function authorBlock(name, fallback, { url, iconUrl } = {}) {
  const block = { name: toField(name || fallback, 256) };
  if (url) block.url = url;
  if (iconUrl) block.icon_url = iconUrl;
  return block;
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

// ----------------------------------------------------------------- Threads

/** Decode the handful of HTML entities Meta puts in its meta tags. */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pull one meta tag out of a page. */
function metaContent(html, property) {
  const match = new RegExp(
    `<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`,
    'i',
  ).exec(html);
  return match ? decodeEntities(match[1]) : null;
}

async function buildThreadsCard({ href }, options) {
  const page = await getHtml(href, options);
  if (!page) return null;

  const description = metaContent(page.html, 'og:description');
  // Without the text there is nothing this card adds over Discord's own
  // preview, which already shows the author and the image.
  if (!description) return null;

  const title = metaContent(page.html, 'og:title') ?? 'Threads';
  const author = title.replace(/\s+on Threads$/i, '').trim();
  const embed = {
    url: metaContent(page.html, 'og:url') ?? href,
    color: THREADS_BLACK,
    author: authorBlock(author, 'Threads', { url: href }),
    description: toField(description, 4096),
    footer: { text: 'Threads' },
  };

  const image = metaContent(page.html, 'og:image');
  // A text-only post still has an og:image: the author's avatar, served from
  // Instagram's profile-photo bucket (type `t51.2885-19`). That belongs in the
  // corner, not across the card. Post media uses other type ids.
  if (image) {
    if (/\/t51\.2885-19\//.test(image)) embed.thumbnail = { url: image };
    else embed.image = { url: image };
  }

  return { embeds: [embed], files: [] };
}

// --------------------------------------------------------------- Facebook

/** Inner HTML of the div that starts at `from`, honouring nesting. */
function innerDiv(html, from) {
  const open = html.indexOf('>', from);
  if (open === -1) return null;
  const start = open + 1;
  let depth = 1;
  const tag = /<\/?div\b/gi;
  tag.lastIndex = start;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, match.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/** Turn the post body's paragraphs and links into plain text. */
function htmlToText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function buildFacebookCard({ href }, options) {
  // The post itself is behind a login wall. The embed iframe is not.
  const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(href)}&show_text=true`;

  // Twice at most: a post that refuses embedding answers the same way every
  // time, but an interstitial or a slow edge node does not, and one retry is
  // cheap next to losing the card.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await getHtml(embedUrl, options);
    if (!page) return null;

    const marker = page.html.indexOf('data-testid="post_message"');
    if (marker === -1) {
      const refused = /tidak tersedia|isn't available|is not available/i.test(page.html);
      // Say why: a forbidden post and an unexpected response look alike from
      // the outside, and both mean "no card".
      console.log(
        `[card] facebook ${page.status} ${page.html.length}B attempt ${attempt + 1}: ` +
          (refused ? 'post refuses embedding' : 'unexpected response'),
      );
      if (refused) return null;
      continue;
    }

    const body = innerDiv(page.html, marker);
    const text = body ? htmlToText(body) : '';
    if (!text) return null;

    // The avatar is the one `<img role="img">` that carries the author name in
    // aria-label. Picking the first aria-label in the document is not the same
    // thing: a reel page puts "Putar video" there first.
    const avatar = [...page.html.matchAll(/<img\b[^>]*>/gi)].find((tag) =>
      tag[0].includes('role="img"'),
    );
    const name = avatar ? /aria-label="([^"]+)"/.exec(avatar[0])?.[1] : null;
    // The iframe's own permalink is authoritative: a post can sit on a vanity
    // path that differs from the page that owns it.
    const handle =
      /href="\/?([\w.-]+)\/posts\//.exec(page.html)?.[1] ||
      new URL(href).pathname.split('/')[1];

    // Media, not avatars: the avatar is served at 40x40.
    const images = [
      ...new Set(
        [...page.html.matchAll(/https:\/\/scontent[^"\\ ]+/g)]
          .map((match) => decodeEntities(match[0]))
          .filter((url) => !url.includes('s40x40')),
      ),
    ];

    const footer = { text: 'Facebook' };
    const embed = {
      url: href,
      color: FACEBOOK_BLUE,
      footer,
      description: toField(text, 4096),
    };
    if (name) {
      embed.author = authorBlock(decodeEntities(name), handle, {
        url: handle && `https://www.facebook.com/${handle}`,
      });
    }
    if (images[0]) embed.image = { url: images[0] };
    // One image per embed, same as every other builder.
    const embeds = [embed, ...imageEmbeds(href, FACEBOOK_BLUE, footer, images.slice(1))];

    return { embeds, files: [] };
  }

  return null;
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
    author: authorBlock(meta.body.userName, 'Pixiv', {
      url: meta.body.userId && `https://www.pixiv.net/users/${meta.body.userId}`,
    }),
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

/** The card site that owns one href, or null. */
function locateCard(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const site = CARD_SITES.find((candidate) =>
    hostMatches(url.hostname.toLowerCase(), candidate.hosts),
  );
  const match = site?.match(url);
  return match ? { url, site, match } : null;
}

/**
 * Resolve one raw URL from the message to a card site.
 *
 * The cleaned URL wins: a shortener was resolved into the real target there,
 * and that target is what carries the id a card needs.
 */
function findCard(raw, cleanedFor) {
  for (const href of [cleanedFor.get(raw), raw]) {
    if (!href) continue;
    const hit = locateCard(href);
    if (hit) return hit;
  }
  return null;
}

/**
 * Build preview cards for the links in a message.
 *
 * @param {string} text raw message content
 * @param {object} [options]
 * @param {Array<{from: string, to: string}>} [options.cleaned] results from
 *   cleanMessage, so a card can show the cleaned URL rather than the tracked one
 * @returns {Promise<Array<{from: string, url: string, embeds: Array, files: Array}>>}
 */
export async function buildCards(text, { cleaned = [], fetchImpl = fetch } = {}) {
  const cleanedFor = new Map(cleaned.map(({ from, to }) => [from, to]));
  const seen = new Set();
  const cards = [];

  // Shared across every card in this message, because Discord counts them per
  // message and a rejected payload would cost the whole reply.
  let filesLeft = MAX_FILES;
  let bytesLeft = MAX_ATTACH_BYTES;
  let embedsLeft = MAX_EMBEDS;

  for (const raw of extractUrls(text)) {
    if (cards.length >= MAX_CARDS) break;

    const hit = findCard(raw, cleanedFor);
    if (!hit) continue;
    const { url, site, match } = hit;

    const key = `${site.id}:${match.slice(1).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const card = await site.build(
        { match, href: url.href },
        { fetchImpl, budget: { files: filesLeft, bytes: bytesLeft } },
      );
      if (!card) {
        // Keep this: a card that silently does not appear is indistinguishable
        // from a link the bot did not recognise.
        console.log(`[card] ${site.id} produced nothing for ${url.href}`);
        continue;
      }

      // A card is taken whole or not at all: a card with half its pages looks
      // broken, and Discord rejects the whole message past ten embeds.
      if (card.embeds.length > embedsLeft || card.files.length > filesLeft) {
        console.log(`[card] ${site.id} skipped: message budget spent`);
        continue;
      }

      cards.push({ from: raw, url: url.href, ...card });
      embedsLeft -= card.embeds.length;
      filesLeft -= card.files.length;
      bytesLeft -= card.files.reduce((total, file) => total + file.attachment.length, 0);
    } catch (error) {
      // A card is decoration, so the reply still goes out — but a swallowed
      // error is invisible in the log, so it is reported here.
      console.log(`[card] ${site.id} failed for ${raw}: ${error.message}`);
    }
  }

  return cards;
}
