import { RULES } from './rules.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

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

/** Pull candidate URLs out of free text. */
export function extractUrls(text) {
  if (typeof text !== 'string') return [];

  return [...text.matchAll(URL_RE)]
    .map((match) => match[0].replace(TRAILING_PUNCTUATION, ''))
    .filter(Boolean);
}

/** Find the rule that owns this URL, if any. */
export function ruleFor(url) {
  const host = url.hostname.toLowerCase();

  return (
    RULES.find((rule) =>
      rule.hosts.some((base) => host === base || host.endsWith(`.${base}`)),
    ) ?? null
  );
}

function matchesHost(host, list = []) {
  return list.some((base) => host === base || host.endsWith(`.${base}`));
}

/** True when the URL is opaque and only the server knows the real target. */
function needsResolve(url, rule) {
  if (matchesHost(url.hostname.toLowerCase(), rule.shorten)) return true;
  return rule.share ? rule.share.test(url.pathname) : false;
}

function stripTracking(url, rule) {
  const out = new URL(url.href);
  const shouldDrop = (name) =>
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
export async function resolveShare(url, { fetchImpl = fetch, maxHops = MAX_HOPS } = {}) {
  let current = new URL(url.href);

  for (let hop = 0; hop < maxHops; hop += 1) {
    const rule = ruleFor(current);
    if (!rule || !needsResolve(current, rule)) break;

    let res;
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
    } catch {
      // Timeout, DNS failure, or a blocked request. We cannot learn the real
      // target, so keep whatever we have and let the caller decide.
      break;
    }

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
function looksLikeFallback(original, resolved, rule) {
  if (resolved.href === original.href) return false;

  if (rule.failure?.some((re) => re.test(resolved.href))) return true;

  // Only judge URLs that stayed on the site the rule describes; a shortener
  // pointing at a different site entirely is legitimate.
  if (!matchesHost(resolved.hostname.toLowerCase(), rule.hosts)) return false;

  // Gave up at the site root.
  if (resolved.pathname === '/' || resolved.pathname === '') return true;

  // Dropped path segments, e.g. /r/x/s/<code> -> /r/x/.
  if (original.pathname.startsWith(resolved.pathname)) return true;

  return false;
}

/**
 * Clean a single URL.
 * @returns {Promise<string|null>} the cleaned URL, or null when the link is
 *   not ours to handle or nothing would change.
 */
export async function cleanUrl(input, options = {}) {
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
  if (looksLikeFallback(url, resolved, ruleFor(resolved) ?? rule)) return null;

  const finalRule = ruleFor(resolved) ?? rule;
  const cleaned = stripTracking(resolved, finalRule);

  return cleaned.href === url.href ? null : cleaned.href;
}

/**
 * Clean every handled link in a message.
 * @returns {Promise<Array<{from: string, to: string}>>} only the links that
 *   actually changed, deduplicated and capped.
 */
export async function cleanMessage(text, options = {}) {
  const seen = new Set();
  const candidates = [];

  for (const raw of extractUrls(text)) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(raw);
    if (candidates.length >= MAX_LINKS) break;
  }

  const results = await Promise.all(
    candidates.map(async (raw) => {
      try {
        const to = await cleanUrl(raw, options);
        return to ? { from: raw, to } : null;
      } catch {
        return null;
      }
    }),
  );

  return results.filter(Boolean);
}
