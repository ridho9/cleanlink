// Shared pieces for every card builder: limits, colours, one HTTP helper,
// the text and embed helpers, and the optional yt-dlp downloader.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIEmbed } from 'discord.js';
import { note } from '../trace.ts';

export type CardEmbed = APIEmbed;

export interface CardOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  timeout?: number;
  budget?: { files?: number; bytes?: number };
}

export interface CardInput {
  href: string;
  match: (string | null)[];
}

export interface CardFile {
  attachment: Buffer;
  name: string;
}

/**
 * How a card's video reaches the channel, if it has one. `attached`: a file in
 * the message. `follow_up`: too large to attach, so `followUp` goes out as its
 * own message, which Discord unfurls into a player. `unfurl`: no card of ours;
 * the card's `url` is a mirror page that Discord previews itself.
 */
export type Playback =
  | { video?: undefined; followUp?: undefined }
  | { video: 'attached'; followUp?: undefined }
  | { video: 'follow_up'; followUp: string }
  | { video: 'unfurl'; followUp?: undefined };

export type BuiltCard = Playback & {
  embeds: CardEmbed[];
  files: CardFile[];
  degraded?: boolean;
  url?: string;
};

/** What attachMedia got: a file that fits, a URL to send on its own, or nothing. */
export type Media =
  | { kind: 'attached'; files: CardFile[] }
  | { kind: 'follow_up'; url: string }
  | { kind: 'none' };

type RequestOptions = CardOptions & { accept?: string; method?: 'HEAD' };
type RefusedMedia = { url: string; size: number };
type VideoFormat = { url?: string; protocol?: string; vcodec?: string; acodec?: string };
type VideoInfo = { formats?: VideoFormat[] };
/**
 * Run a media tool and return its output.
 *
 * Spawned detached, so it leads its own process group. yt-dlp merges its two
 * streams through ffmpeg, a separate child: a timeout that killed only yt-dlp
 * left the merge writing into a directory the caller was about to remove. The
 * whole group is killed when the call fails, which includes the timeout.
 */
function run(
  command: string,
  args: string[],
  { timeout, maxBuffer = 1024 * 1024 }: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // No member of the group is left.
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        killGroup();
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    };

    timer = setTimeout(() => finish(new Error(`${command} took longer than ${timeout / 1000} s`)), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) finish(new Error(`${command} wrote more than ${maxBuffer} bytes`));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) finish(new Error(`${command} wrote more than ${maxBuffer} bytes`));
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      finish(code === 0 ? undefined : new Error(`${command} exited with ${code}: ${stderr.split('\n')[0]}`));
    });
  });
}

const BROWSER_UA = 'Mozilla/5.0';
const TIMEOUT_MS = 6000;
// A media file is read to the end before the reply goes out, and measured
// 0.5-5 s for 0.5-6.6 MB from the CDNs the cards use. Ten seconds is that
// with margin and half the old 20 s worst case; a slower file is dropped and
// the card keeps its still.
const MEDIA_TIMEOUT_MS = 10_000;
// A yt-dlp download fetches and merges two streams, so it gets longer.
const DOWNLOAD_TIMEOUT_MS = 30_000;
// Card pages run 0.5-1 MB. A body past this cap is an error page or an
// outright attack, and the deadline alone does not stop it from being read.
const MAX_BODY_BYTES = 8_000_000;

// A message can carry several cards, but each one spends the same per-message
// budget that Discord enforces, so the limits below are shared, not per card.
export const MAX_CARDS = 5; // mirrors the cleaner's 5-link cap
export const MAX_EMBEDS = 10; // Discord's hard limit per message
export const MAX_FILES = 10; // Discord's hard limit per message
// Discord's upload limit is 10 MiB on unboosted and tier 1 servers and in DMs.
// The margin covers the rest of the request: the JSON payload and the
// multipart framing.
export const MAX_ATTACH_BYTES = 9_500_000;
// The largest video file Discord was seen to unfurl into a player from a bare
// link: a 14,937,148-byte reel played, 23.9 MB and 39.5 MB files got no embed.
export const MAX_UNFURL_BYTES = 15_000_000;

export const X_BLUE = 0x1d9bf0;
export const PIXIV_BLUE = 0x0096fa;
export const TIKTOK_BLACK = 0x010101;
export const THREADS_BLACK = 0x000000;
export const FACEBOOK_BLUE = 0x1877f2;
/** Sent to unfurl providers that only serve their tags to link crawlers. */
export const UNFURL_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
export const NHENTAI_RED = 0xed2553;
export const INSTAGRAM_PINK = 0xe1306c;
export const MANGADEX_ORANGE = 0xff6740;
export const REDDIT_ORANGE = 0xff4500;

// ---------------------------------------------------------------- utilities

/**
 * Neutralise Discord markdown in text we did not write.
 *
 * Escaping runs before clipping so a truncated string can never end on a lone
 * backslash that would swallow the character after it.
 */
export function escapeMarkdown(text: unknown): string {
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
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // A trailing backslash means the cut landed inside an escape sequence.
  return `${cut.endsWith('\\') ? cut.slice(0, -1) : cut}…`;
}

/** Escape free text from a third party, then fit it into a field. */
export function toField(text: unknown, max: number): string {
  return clip(escapeMarkdown(text), max);
}

/**
 * One request, with the headers and timeout every builder needs.
 *
 * Retried once when the request itself fails — a connect error or a timeout —
 * because a dropped connection there costs the whole card. An HTTP error status
 * is not retried: that is an answer, not a hiccup.
 */
async function request(url: string, { fetchImpl = fetch, accept, method, headers = {}, timeout = TIMEOUT_MS }: RequestOptions = {}): Promise<Response> {
  const init = {
    ...(method ? { method } : {}),
    headers: {
      'user-agent': BROWSER_UA,
      ...(accept ? { accept } : {}),
      ...headers,
    },
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      // A deadline per attempt: one signal for both attempts is already
      // aborted when the first one timed out, so the retry never had a chance.
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      // A retry is for a connect error that may not repeat. A deadline that
      // passed says the other side is slow, and asking again only doubles the
      // wait.
      const name = (error as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      if (attempt === 1 || timedOut) {
        note(`[card] ${new URL(url).host} ${timedOut ? 'timed out' : 'failed twice'}: ${(error as Error).message}`);
        throw error;
      }
    }
  }
}

export async function getJson<T>(url: string, options?: CardOptions): Promise<T | null> {
  const res = await request(url, { ...options, accept: 'application/json' });
  if (!res.ok) return null;
  const body = await readTextCapped(res);
  if (body === null) {
    note(`[card] ${new URL(url).host} answered with a body over ${MAX_BODY_BYTES / 1_000_000} MB`);
    return null;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    // A JSON endpoint answering HTML is an error page, not a card.
    note(`[card] ${new URL(url).host} answered non-JSON`);
    return null;
  }
}

/**
 * Whether `url` ends at an image, asked with HEAD so nothing is downloaded.
 * A mirror's media path can lead to a video, which an embed cannot show.
 */
export async function servesImage(url: string, options?: CardOptions): Promise<boolean> {
  try {
    const res = await request(url, { ...options, method: 'HEAD' });
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

/**
 * The page and its status, also when the status is an error.
 *
 * A builder that has a fallback wants `getHtml`: no answer, no page. A builder
 * that reports the failure wants the status, which `getHtml` throws away.
 */
export async function readPage(url: string, options?: CardOptions): Promise<{ status: number; html: string | null }> {
  const res = await request(url, { ...options, accept: 'text/html' });
  if (!res.ok) return { status: res.status, html: null };
  const html = await readTextCapped(res);
  if (html === null) {
    note(`[card] ${new URL(url).host} answered with a body over ${MAX_BODY_BYTES / 1_000_000} MB`);
  }
  return { status: res.status, html };
}

export async function getHtml(url: string, options?: CardOptions): Promise<{ status: number; html: string } | null> {
  const { status, html } = await readPage(url, options);
  return html === null ? null : { status, html };
}

/**
 * Attach the media, or queue it for a follow-up message.
 *
 * A file that fits the message budget is attached. One refused only because of
 * its size becomes a `followUp` URL, which Discord unfurls into a player on its
 * own message. A URL that did not answer at all is neither - sending it would
 * add a dead link to the channel.
 *
 * Candidates are ordered best rendition first.
 */
export async function attachMedia(candidates: string | string[] | null, options: CardOptions = {}, name = 'video.mp4'): Promise<Media> {
  const urls = [candidates].flat().filter((url): url is string => Boolean(url));
  if (urls.length === 0) return { kind: 'none' };

  const media = await downloadMedia(urls, options, name);
  if (media.files) return { kind: 'attached', files: media.files };
  const url = followUpOf(media.refused);
  return url ? { kind: 'follow_up', url } : { kind: 'none' };
}

/** The card fields for a video that attachMedia got. */
export function playback(media: Media): Playback & { files: CardFile[] } {
  switch (media.kind) {
    case 'attached':
      return { files: media.files, video: 'attached' };
    case 'follow_up':
      return { files: [], video: 'follow_up', followUp: media.url };
    case 'none':
      return { files: [] };
  }
}

/**
 * The rendition to send as a follow-up: the largest that Discord still
 * unfurls. No link when every file that declared a size is past that ceiling,
 * because Discord would show a bare URL instead of a player; the card keeps
 * its poster and the post's own link. A URL that never answered is not a
 * candidate either, and one that declared no size is still worth the try.
 * Refused files are best first; size is 0 when the server did not declare it.
 */
function followUpOf(refused: RefusedMedia[]): string | null {
  if (refused.length === 0) return null;
  const known = refused.filter((item) => item.size > 0);
  const playable = known.filter((item) => item.size <= MAX_UNFURL_BYTES);
  if (playable.length > 0) return playable.reduce((a, b) => (b.size > a.size ? b : a)).url;
  if (known.length > 0) return null;
  return refused[0].url;
}

/**
 * Download one media file as an attachment.
 *
 * The declared length is checked before the body is read, so an oversized
 * video is refused rather than pulled into memory and then discarded. The
 * deadline is longer than a page fetch because a 9 MB file over a slow link
 * is not a hung request.
 */
export async function downloadMedia(urls: string | string[], options: CardOptions = {}, name = 'video.mp4'): Promise<{ files: CardFile[] | null; refused: RefusedMedia[] }> {
  const cap = Math.min(MAX_ATTACH_BYTES, options.budget?.bytes ?? MAX_ATTACH_BYTES);
  // A file refused for its size is still a live URL, which is what makes it a
  // candidate for the follow-up message. A URL that answered 404 is not.
  const refused: RefusedMedia[] = [];

  // Candidates arrive best first. A rendition that does not fit is skipped
  // before its body is read, so a smaller one can still be attached.
  for (const url of [urls].flat().filter(Boolean)) {
    const started = Date.now();
    let res;
    try {
      res = await request(url, { ...options, timeout: MEDIA_TIMEOUT_MS });
    } catch (error) {
      note(`[card] ${new URL(url).host} media failed: ${(error as Error).message}`);
      continue;
    }
    // A skipped body is cancelled: left unread, it holds the connection open
    // until the media timeout. Not awaited, as in readCapped.
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      note(`[card] ${new URL(url).host} media answered ${res.status}`);
      continue;
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > cap) {
      res.body?.cancel().catch(() => {});
      note(`[card] ${new URL(url).host} media is ${Math.round(declared / 1024)}KB, over the budget`);
      refused.push({ url, size: declared });
      continue;
    }

    let buffer;
    try {
      buffer = await readCapped(res, cap);
    } catch (error) {
      // The deadline covers the body read too. A stream that dies mid-file
      // costs this candidate, not the card that owns it.
      note(`[card] ${new URL(url).host} media read failed: ${(error as Error).message}`);
      continue;
    }
    if (buffer === null) {
      refused.push({ url, size: declared });
      continue;
    }
    if (buffer.length === 0) continue;
    // The reply waits for this read, so a slow file is worth a log line: it is
    // the number behind a slow message in the review.
    const ms = Date.now() - started;
    if (ms > 3000) {
      note(`[card] ${new URL(url).host} media ${Math.round(buffer.length / 1024)}KB in ${(ms / 1000).toFixed(1)}s`);
    }
    return { files: [{ attachment: buffer, name }], refused };
  }

  return { files: null, refused };
}

/** Download one image, or null when it fails, is empty, or exceeds `cap`. */
export async function getBytes(url: string, options?: CardOptions, cap = MAX_ATTACH_BYTES): Promise<Buffer | null> {
  const res = await request(url, options);
  if (!res.ok) return null;
  const buffer = await readCapped(res, cap);
  if (!buffer || buffer.length === 0) return null;
  return buffer;
}

/**
 * Read a response body, but stop at `cap` bytes and return null.
 *
 * `content-length` is only a claim, and a chunked response has none, so the
 * body is counted while it streams: a file over the budget is never held in
 * memory in full.
 */
async function readChunks(res: Response, cap: number): Promise<Uint8Array[] | null> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    total += value.length;
    if (total > cap) {
      // Not awaited: the answer is already known, and a cancel can wait on
      // the other side of the connection.
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const chunks = await readChunks(res, cap);
  if (chunks === null) return null;
  return Buffer.concat(chunks);
}

/**
 * Read a page or JSON body, but stop past `MAX_BODY_BYTES`.
 * @returns The body, or null when it ran past the cap.
 */
async function readTextCapped(res: Response): Promise<string | null> {
  const chunks = await readChunks(res, MAX_BODY_BYTES);
  if (chunks === null) return null;
  return Buffer.concat(chunks).toString('utf8');
}

/** A code point, or null when the number cannot form one. */
function codePoint(value: number): string | null {
  const valid = Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return valid ? String.fromCodePoint(value) : null;
}

/** Decode the handful of HTML entities Meta puts in its meta tags. */
export function decodeEntities(text: unknown): string {
  return String(text ?? '')
    // A page may name a code point that does not exist; the entity stays.
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => codePoint(parseInt(hex, 16)) ?? whole)
    .replace(/&#(\d+);/g, (whole, dec) => codePoint(Number(dec)) ?? whole)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pull one meta tag out of a page. */
export function metaContent(html: string, property: string): string | null {
  const match = new RegExp(
    `<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`,
    'i',
  ).exec(html);
  return match ? decodeEntities(match[1]) : null;
}

/**
 * The stat line every card ends its text with.
 *
 * Discord keeps inline fields in a row on the desktop client, but stacks them
 * one per row on a phone, where four numbers became four rows. One line of icon
 * and number reads the same at either width. A value that is missing, or is not
 * a number or a non-empty string, is dropped.
 */
export function statLine(entries: Array<[string, unknown]>): string | null {
  const parts: string[] = [];
  for (const [icon, value] of entries) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) parts.push(`${icon} ${value.toLocaleString('en-US')}`);
    } else if (typeof value === 'string' && value.trim()) {
      parts.push(`${icon} ${value.trim()}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Image-only embeds: every image after the first on a card gets one. */
export function imageEmbeds(url: string | undefined, color: number, footer: CardEmbed['footer'], images: string[]): CardEmbed[] {
  return images.map((image) => ({ url, color, footer, image: { url: image } }));
}

/**
 * The same, numbered `label(position, total)`: every image after the first
 * gets one embed and says where it sits in the set, so a reader knows how many
 * pictures the card holds. Callers pass the whole list; the first image stays
 * on the card's own embed.
 */
export function numberedEmbeds(
  url: string | undefined,
  color: number,
  images: string[],
  label: (position: number, total: number) => string,
): CardEmbed[] {
  const total = images.length;
  return images.slice(1).map((image, index) => ({
    url,
    color,
    image: { url: image },
    footer: { text: label(index + 2, total) },
  }));
}

/** The author block, with whichever of its two optional fields exist. */
export function authorBlock(name: string | null | undefined, fallback: string | null | undefined, { url, iconUrl }: { url?: string | null; iconUrl?: string | null } = {}): NonNullable<CardEmbed['author']> {
  const block: NonNullable<CardEmbed['author']> = { name: toField(name || fallback, 256) };
  if (url) block.url = url;
  if (iconUrl) block.icon_url = iconUrl;
  return block;
}

/** Guess an extension from a URL path, defaulting to jpg. */
export function extensionOf(url: string): string {
  const path = new URL(url).pathname.toLowerCase();
  const match = /\.(jpg|jpeg|png|gif|webp)$/.exec(path);
  return match ? match[1].replace('jpeg', 'jpg') : 'jpg';
}

/**
 * The single-file video renditions of a page, best first, via yt-dlp.
 *
 * Only files that carry both picture and sound: Discord can attach or unfurl
 * those, never a DASH stream. Every one is returned, not just the best,
 * because the best is often too large for both an upload and an unfurl while a
 * lower one fits.
 *
 * Optional by design: no yt-dlp, or a page it cannot parse, returns [] and the
 * caller keeps its still. Spawned with an argv array (never a shell) under a
 * timeout.
 *
 * href is the page URL, already validated by the caller's matcher.
 */
export async function videoLinks(href: string): Promise<string[]> {
  try {
    const { stdout } = await run('yt-dlp', [
      '-J',
      '--no-warnings',
      '--no-playlist',
      href,
    ], { timeout: MEDIA_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    const urls = progressiveUrls(JSON.parse(stdout) as VideoInfo);
    note(`[card] ${new URL(href).host} ${urls.length} video link(s) via yt-dlp`);
    return urls;
  } catch (error) {
    note(`[card] ${new URL(href).host} video link failed: ${((error as Error & { shortMessage?: string }).shortMessage ?? (error as Error).message).split('\n')[0]}`);
    return [];
  }
}

/**
 * Picture-and-sound https formats from a yt-dlp info document, best first.
 * yt-dlp lists formats worst first. A codec reported as 'none' marks a DASH
 * half; Facebook's `hd`/`sd` report no codec at all and are complete files.
 */
export function progressiveUrls(info: VideoInfo | null | undefined): string[] {
  return (info?.formats ?? [])
    .filter((f): f is VideoFormat & { url: string } => Boolean(f.url && f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none'))
    .map((f) => f.url)
    .reverse();
}

/**
 * Download a video with yt-dlp as an attachment, or null.
 *
 * Optional by design: no yt-dlp, an unparseable page, or a file over the
 * message budget all return null. yt-dlp gets an argv array (never a shell),
 * a timeout, and a temporary directory that is always removed.
 *
 * `format` is the yt-dlp selector. The default wants a progressive file; an
 * HLS source (Reddit) has no such rendition and names its own.
 */
export async function downloadVideo(href: string, options: CardOptions = {}, format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best'): Promise<CardFile[] | null> {
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
      '-f', format,
      '--merge-output-format', 'mp4',
      '-o', file,
      href,
    ], { timeout: DOWNLOAD_TIMEOUT_MS });

    let buffer;
    try {
      buffer = await readFile(file);
    } catch {
      // yt-dlp exits successfully when it skips a file bigger than
      // --max-filesize, leaving nothing behind.
      note(`[card] video skipped for ${new URL(href).host}: over the attachment budget`);
      return null;
    }
    if (buffer.length === 0 || buffer.length > cap) return null;
    return [{ attachment: buffer, name: 'video.mp4' }];
  } catch (error) {
    note(`[card] video via yt-dlp failed for ${new URL(href).host}: ${((error as Error & { shortMessage?: string }).shortMessage ?? (error as Error).message).split('\n')[0]}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
