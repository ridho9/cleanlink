import { RULES } from './rules.ts';
import type { Rule } from './rules.ts';
import { mark, note, withUrl } from './trace.ts';

export interface UrlMatch {
  raw: string;
  start: number;
  end: number;
}

export interface CleanedLink {
  from: string;
  to: string;
}

export interface CleanOptions {
  fetchImpl?: typeof fetch;
  maxHops?: number;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>|]+$/;

const MAX_LINKS = 5;
const MAX_HOPS = 3;
const TIMEOUT_MS = 4000;

// The default is the bare Mozilla prefix, and that is not a mistake.
//
// This request exists to collect a 3xx. Platforms that sniff for a real
// browser answer a browser string with their JavaScript shell instead (HTTP
// 200, no redirect, no OpenGraph tags), so a generic client gets the redirect
// and a "real browser" gets nothing. Verified on Threads and Facebook;
// fb.watch even answers 400 to a Chrome UA.
//
// A rule can override this with `ua` — some sites go the other way and refuse
// anything that is not a browser.
const DEFAULT_USER_AGENT = 'Mozilla/5.0';

const GLOBAL_TRACKING = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^twclid$/i,
  /^yclid$/i,
  /^mibextid$/i,
  /^igshid$/i,
  /^igsh$/i,
  /^_ga$/i,
  /^_gl$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
];

/**
 * Pull candidate URLs out of free text, with the offsets they occupy.
 * The offsets let a caller tell "this text is inside a URL" from "this text
 * stands on its own", which the `nh/123` shorthand depends on.
 * @returns Candidate URLs with their offsets.
 */
export function findUrls(text: unknown): UrlMatch[] {
  if (typeof text !== 'string') return [];

  return [...text.matchAll(URL_RE)]
    .map((match) => {
      const raw = match[0].replace(TRAILING_PUNCTUATION, '');
      return raw ? { raw, start: match.index, end: match.index + raw.length } : null;
    })
    .filter((match): match is UrlMatch => Boolean(match))
    // A link inside `||…||` is hidden on purpose. Cleaning it or carding it
    // would show it again, so the bot leaves it alone.
    .filter((match) => !isSpoiled(text, match.start, match.end));
}

/** True when the link at these offsets sits inside Discord spoiler markup. */
function isSpoiled(text: string, start: number, end: number): boolean {
  return text[start - 1] === '|' && text[end] === '|';
}

/** Pull candidate URLs out of free text. */
export function extractUrls(text: unknown) {
  return findUrls(text).map(({ raw }) => raw);
}

/** True when this text contains a link the cleaner would handle. */
export function handlesAny(text: unknown) {
  return extractUrls(text).some((raw) => {
    try {
      return ruleFor(new URL(raw)) !== null;
    } catch {
      return false;
    }
  });
}

/** Find the rule that owns this URL, if any. */
export function ruleFor(url: URL): Rule | null {
  const host = url.hostname.toLowerCase();

  return RULES.find((rule) => hostMatches(host, rule.hosts)) ?? null;
}

/** True when a hostname is one of these domains or a subdomain of one. */
export function hostMatches(host: unknown, list: string[] = []) {
  // DNS names are case-insensitive, and `URL` already lowercases `hostname`;
  // normalising here too means a caller cannot break the match by handing in
  // an untouched `Host` header.
  const name = String(host).toLowerCase();
  return list.some((base) => name === base || name.endsWith(`.${base}`));
}

/** True when the URL is opaque and only the server knows the real target. */
function needsResolve(url: URL, rule: Rule) {
  if (hostMatches(url.hostname.toLowerCase(), rule.shorten)) return true;
  return rule.share ? rule.share.test(url.pathname) : false;
}

function stripTracking(url: URL, rule: Rule) {
  const out = new URL(url.href);

  // On a permalink, every query parameter is decoration: X's `a`/`s`/`t`,
  // Instagram's `mdxt`/`psln`, TikTok's `_t`. Dropping the whole query there
  // is future-proof against tokens that did not exist when the rule was
  // written; the explicit list only has to cover every other URL shape.
  const dropAll = rule.dropAllOn ? rule.dropAllOn.test(url.pathname) : false;

  // The mirror image: a URL shape whose identity is one named parameter.
  // YouTube's `watch?v=…` is the case — the video is `v`, everything else is
  // playlist or radio state.
  const keepOnly =
    rule.keepOnly && rule.keepOnly.path.test(url.pathname) ? rule.keepOnly.keep : null;

  const shouldDrop = (name: string) =>
    keepOnly
      ? !keepOnly.some((re) => re.test(name))
      : dropAll ||
        GLOBAL_TRACKING.some((re) => re.test(name)) ||
        rule.drop.some((re) => re.test(name));

  for (const name of [...out.searchParams.keys()]) {
    if (shouldDrop(name)) out.searchParams.delete(name);
  }

  return out;
}

/**
 * Follow redirects for opaque share links, without ever leaving the
 * allowlist: a hop is only fetched while the current URL is still a
 * share/shortener URL owned by a rule. Redirect targets outside the rules
 * are returned but never requested, which is what keeps this SSRF-safe.
 */
async function resolveShare(url: URL, { fetchImpl = fetch, maxHops = MAX_HOPS }: CleanOptions = {}) {
  let current = new URL(url.href);

  for (let hop = 0; hop < maxHops; hop += 1) {
    const rule = ruleFor(current);
    if (!rule || !needsResolve(current, rule)) break;

    let res;
    // Twice: a share resolution is one request, and it is the only thing that
    // turns an opaque code into a real URL. A single timeout used to mean a
    // silent drop, which looks identical to "this link is not mine".
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        res = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': rule.ua ?? DEFAULT_USER_AGENT,
            accept: 'text/html,*/*',
            'accept-language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        break;
      } catch (error) {
        // Timeout, DNS failure, or a blocked request.
        if (attempt === 1) {
          note(`[resolve] ${current.href} failed twice: ${(error as Error).message}`);
          mark('resolve', 'failed');
        }
      }
    }
    if (!res) break;

    try {
      await res.body?.cancel();
    } catch {
      // Body is irrelevant; ignore cancellation failures.
    }

    const location = res.headers.get('location');
    if (!location) break;

    const next = new URL(location, current);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') break;

    current = next;
  }

  return current;
}

/**
 * Detect a redirect that did not actually resolve anything.
 *
 * Shorteners do not answer "unknown code" with an error — they bounce you to
 * their own front page or to a parent path, and some sites send you to a login
 * or consent page. Verified against the live hosts:
 *
 *   fb.watch/bogus      -> facebook.com/watch/
 *   vm.tiktok.com/bogus -> tiktok.com/?_r=1
 *
 * Returning those would be worse than staying silent, so they are rejected.
 */
function looksLikeFallback(original: URL, resolved: URL, rule: Rule) {
  if (resolved.href === original.href) return false;

  if (rule.failure?.some((re) => re.test(resolved.href))) return true;

  // Only judge URLs that stayed on the site the rule describes; a shortener
  // pointing at a different site entirely is legitimate.
  if (!hostMatches(resolved.hostname.toLowerCase(), rule.hosts)) return false;

  // Gave up at the site root.
  if (resolved.pathname === '/' || resolved.pathname === '') return true;

  // Dropped path segments, e.g. /r/x/s/<code> -> /r/x/.
  if (original.pathname.startsWith(resolved.pathname)) return true;

  return false;
}

/**
 * Clean a single URL.
 * @returns The cleaned URL, or null when the link is
 *   not ours to handle or nothing would change.
 */
export async function cleanUrl(input: string, options: CleanOptions = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const rule = ruleFor(url);
  if (!rule) return null;

  const resolved = await resolveShare(url, options);
  // A share link that is still a share link was not resolved: the code is
  // fake or expired, or the site stopped redirecting. Worth a line in review.
  if (needsResolve(url, rule) && resolved.href === url.href) {
    note(`[resolve] ${url.href} did not redirect`);
    mark('redirect', 'none');
  }
  if (looksLikeFallback(url, resolved, ruleFor(resolved) ?? rule)) {
    note(`[resolve] ${url.href} fell back to ${resolved.href}`);
    mark('resolve', 'fallback');
    return null;
  }

  const finalRule = ruleFor(resolved) ?? rule;
  const cleaned = stripTracking(resolved, finalRule);

  return cleaned.href === url.href ? null : cleaned.href;
}

/**
 * Identity of a link for de-duplication. Host and scheme are case-insensitive,
 * the path and query are not: `youtu.be/AbCdEf` and `youtu.be/abcdef` are two
 * different videos, so folding the whole URL case would silently drop one.
 */
function dedupeKey(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

/**
 * Clean every handled link in a message.
 * @returns Only the links that
 *   actually changed, deduplicated and capped.
 */
export async function cleanMessage(text: unknown, options: CleanOptions = {}): Promise<CleanedLink[]> {
  const seen = new Set();
  const candidates = [];

  for (const raw of extractUrls(text)) {
    const key = dedupeKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(raw);
    if (candidates.length >= MAX_LINKS) break;
  }

  const results = await Promise.all(
    candidates.map((raw) => withUrl(raw, async () => {
      try {
        const to = await cleanUrl(raw, options);
        mark('clean', to ?? 'unchanged');
        return to ? { from: raw, to } : null;
      } catch (error) {
        // Never fatal, but never silent either: an exception here used to leave
        // the message unanswered with nothing in the log.
        note(`[clean] ${raw} failed: ${(error as Error).message}`);
        mark('clean', 'error');
        return null;
      }
    })),
  );

  return results.filter((result): result is CleanedLink => Boolean(result));
}
