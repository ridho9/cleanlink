// Shared pieces for every card builder: limits, colours, one HTTP helper,
// the text and embed helpers, and the optional yt-dlp downloader.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BROWSER_UA = 'Mozilla/5.0';
const TIMEOUT_MS = 6000;
const MEDIA_TIMEOUT_MS = 20_000;

// A message can carry several cards, but each one spends the same per-message
// budget that Discord enforces, so the limits below are shared, not per card.
export const MAX_CARDS = 5; // mirrors the cleaner's 5-link cap
export const MAX_EMBEDS = 10; // Discord's hard limit per message
export const MAX_FILES = 10; // Discord's hard limit per message
export const MAX_IMAGES = 5; // pages per Pixiv work, matching SaucyBot's cap
export const MAX_ATTACH_BYTES = 8_000_000; // below Discord's default 10 MB limit

export const X_BLUE = 0x1d9bf0;
export const PIXIV_BLUE = 0x0096fa;
export const TIKTOK_BLACK = 0x010101;
export const THREADS_BLACK = 0x000000;
export const FACEBOOK_BLUE = 0x1877f2;
export const NHENTAI_RED = 0xed2553;
export const INSTAGRAM_PINK = 0xe1306c;

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

/**
 * One request, with the headers and timeout every builder needs.
 *
 * Retried once when the request itself fails — a connect error or a timeout —
 * because a dropped connection there costs the whole card. An HTTP error status
 * is not retried: that is an answer, not a hiccup.
 */
async function request(url, { fetchImpl = fetch, accept, headers = {}, timeout = TIMEOUT_MS } = {}) {
  const init = {
    headers: {
      'user-agent': BROWSER_UA,
      ...(accept ? { accept } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (attempt === 1) {
        console.log(`[card] ${new URL(url).host} failed twice: ${error.message}`);
        throw error;
      }
    }
  }
}

export async function getJson(url, options) {
  const res = await request(url, { ...options, accept: 'application/json' });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    // A JSON endpoint answering HTML is an error page, not a card.
    console.log(`[card] ${new URL(url).host} answered non-JSON`);
    return null;
  }
}

export async function getHtml(url, options) {
  const res = await request(url, { ...options, accept: 'text/html' });
  if (!res.ok) return null;
  return { status: res.status, html: await res.text() };
}

/**
 * Attach the media, or queue it for a follow-up message.
 *
 * A file that fits the message budget is attached. One refused only because of
 * its size becomes a `followUp` URL, which Discord unfurls into a player on its
 * own message. A URL that did not answer at all is neither - sending it would
 * add a dead link to the channel.
 *
 * @param {string|string[]|null} candidates best rendition first
 * @returns {Promise<{files: Array, followUp: string|null}>}
 */
export async function attachMedia(candidates, options = {}, name = 'video.mp4') {
  const urls = [candidates].flat().filter(Boolean);
  if (urls.length === 0) return { files: [], followUp: null };

  const media = await downloadMedia(urls, options, name);
  if (media.files) return { files: media.files, followUp: null };
  return { files: [], followUp: media.refusedForSize ? urls[0] : null };
}

/**
 * Download one media file as an attachment.
 *
 * The declared length is checked before the body is read, so an oversized
 * video is refused rather than pulled into memory and then discarded. The
 * deadline is longer than a page fetch because an 8 MB file over a slow link
 * is not a hung request.
 */
export async function downloadMedia(urls, options = {}, name = 'video.mp4') {
  const cap = Math.min(MAX_ATTACH_BYTES, options.budget?.bytes ?? MAX_ATTACH_BYTES);
  // A file refused for its size is still a live URL, which is what makes it a
  // candidate for the follow-up message. A URL that answered 404 is not.
  let refusedForSize = false;

  // Candidates arrive best first. A rendition that does not fit is skipped
  // before its body is read, so a smaller one can still be attached.
  for (const url of [urls].flat().filter(Boolean)) {
    let res;
    try {
      res = await request(url, { ...options, timeout: MEDIA_TIMEOUT_MS });
    } catch (error) {
      console.log(`[card] ${new URL(url).host} media failed: ${error.message}`);
      continue;
    }
    if (!res.ok) {
      console.log(`[card] ${new URL(url).host} media answered ${res.status}`);
      continue;
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > cap) {
      console.log(`[card] ${new URL(url).host} media is ${Math.round(declared / 1024)}KB, over the budget`);
      refusedForSize = true;
      continue;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > cap) {
      refusedForSize = true;
      continue;
    }
    if (buffer.length === 0) continue;
    return { files: [{ attachment: buffer, name }], refusedForSize: false };
  }

  return { files: null, refusedForSize };
}

export async function getBytes(url, options) {
  const res = await request(url, options);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return null;
  return buffer;
}

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
export function metaContent(html, property) {
  const match = new RegExp(
    `<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`,
    'i',
  ).exec(html);
  return match ? decodeEntities(match[1]) : null;
}

/**
 * The stats block every card ends with.
 * @param {Array<[string, unknown]>} entries name/value pairs; a pair is dropped
 *   when its value is not a number
 */
export function statFields(entries) {
  const rows = entries.filter(([, value]) => Number.isFinite(value));
  if (rows.length === 0) return null;
  return rows.map(([name, value]) => ({
    name,
    value: value.toLocaleString('en-US'),
    inline: true,
  }));
}

/** Image-only embeds: every image after the first on a card gets one. */
export function imageEmbeds(url, color, footer, images) {
  return images.map((image) => ({ url, color, footer, image: { url: image } }));
}

/** The author block, with whichever of its two optional fields exist. */
export function authorBlock(name, fallback, { url, iconUrl } = {}) {
  const block = { name: toField(name || fallback, 256) };
  if (url) block.url = url;
  if (iconUrl) block.icon_url = iconUrl;
  return block;
}

/** Guess an extension from a URL path, defaulting to jpg. */
export function extensionOf(url) {
  const path = new URL(url).pathname.toLowerCase();
  const match = /\.(jpg|jpeg|png|gif|webp)$/.exec(path);
  return match ? match[1].replace('jpeg', 'jpg') : 'jpg';
}

/**
 * Download a video with yt-dlp and hand back an attachment.
 *
 * Optional by design: no yt-dlp, an unparseable video, or a file larger than
 * the message budget all return null, and the caller falls back to a poster
 * frame or a link. yt-dlp is spawned with an argv array (never a shell), under
 * a timeout, into a temporary directory that is always removed.
 *
 * @param {string} href page URL, already validated by the caller's matcher
 * @param {object} options card options, for the shared attachment budget
 * @param {object} [format] extra yt-dlp arguments, e.g. a height cap
 */
export async function videoLink(href, options = {}) {
  try {
    const { stdout } = await run('yt-dlp', [
      '-g',
      '--no-warnings',
      '--no-playlist',
      '-f', 'best[ext=mp4]/best',
      href,
    ], { timeout: MEDIA_TIMEOUT_MS });

    // A merged format prints two lines; a progressive one prints a single URL,
    // which is what Discord can unfurl and play.
    const [url] = stdout.trim().split('\n').filter(Boolean);
    if (!url) return null;
    console.log(`[card] ${new URL(href).host} video link via yt-dlp`);
    return url;
  } catch (error) {
    console.log(`[card] ${new URL(href).host} video link failed: ${(error.shortMessage ?? error.message).split('\n')[0]}`);
    return null;
  }
}

export async function downloadVideo(href, options = {}, format = {}) {
  const budget = options.budget ?? {};
  if ((budget.files ?? 1) <= 0) return null;

  const cap = Math.min(MAX_ATTACH_BYTES, budget.bytes ?? MAX_ATTACH_BYTES);
  const dir = await mkdtemp(join(tmpdir(), 'cleanlink-'));
  const file = join(dir, 'video.mp4');
  try {
    await run('yt-dlp', [
      '--no-warnings',
      '--no-playlist',
      '--max-filesize', String(cap),
      ...(format.args ?? ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best']),
      '--merge-output-format', 'mp4',
      '-o', file,
      href,
    ], { timeout: 30_000 });

    let buffer;
    try {
      buffer = await readFile(file);
    } catch {
      // yt-dlp exits successfully when it skips a file bigger than
      // --max-filesize, leaving nothing behind.
      console.log(`[card] video skipped for ${new URL(href).host}: over the attachment budget`);
      return null;
    }
    if (buffer.length === 0 || buffer.length > cap) return null;
    return [{ attachment: buffer, name: 'video.mp4' }];
  } catch (error) {
    console.log(`[card] video via yt-dlp failed for ${new URL(href).host}: ${(error.shortMessage ?? error.message).split('\n')[0]}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
