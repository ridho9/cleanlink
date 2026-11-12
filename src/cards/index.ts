import { findUrls, hostMatches, isSpoiled } from '../clean.ts';
import { buildFacebookCard } from './facebook.ts';
import { buildInstagramCard } from './instagram.ts';
import { buildMangadexCard } from './mangadex.ts';
import { buildNhentaiCard } from './nhentai.ts';
import { buildPixivCard } from './pixiv.ts';
import { buildRedditCard } from './reddit.ts';
import { buildThreadsCard } from './threads.ts';
import { buildTikTokCard } from './tiktok.ts';
import { buildXCard } from './x.ts';
import {
  MAX_ATTACH_BYTES,
  MAX_CARDS,
  MAX_EMBEDS,
  MAX_FILES,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';
import { mark, note, withUrl } from '../trace.ts';

// Preview cards for the links where Discord's own unfurl is broken or thin.

// Discord counts embed text per message: 6000 characters across every embed.
// A card past that is refused with the whole reply, so it is dropped here.
const MAX_EMBED_CHARS = 6000;

/** The characters Discord counts for one embed. */
function embedChars(embed: CardEmbed): number {
  const fields = (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    fields
  );
}
// Sites with a good native preview need nothing here: Misskey answers Discord's
// crawler with complete OpenGraph tags, and YouTube has a native player.
//
// Adding a site is a table entry plus a builder module. Keep it that way.

export type Card = BuiltCard & {
  from: string;
  url: string;
};

/** The sites that own a card; the `card` field of the log names one of them. */
export type SiteId = 'x' | 'pixiv' | 'instagram' | 'threads' | 'facebook' | 'nhentai' | 'tiktok' | 'mangadex' | 'reddit';

/** What a card shows besides text, as the `media` field of the log names it. */
export type MediaKind = 'video' | 'follow_up' | 'unfurl' | `images:${number}` | 'text';

interface CardSite {
  id: SiteId;
  hosts: string[];
  match: (url: URL) => (string | null)[] | null;
  build: (input: CardInput, options: CardOptions) => Promise<BuiltCard | null>;
}

interface CardHit {
  url: URL;
  site: CardSite;
  match: (string | null)[];
}

interface BuildCardsOptions {
  cleaned?: Array<{ from: string; to: string }>;
  fetchImpl?: typeof fetch;
}

/** Sites that own a card, kept separate from the tracker rules in rules.js. */
const CARD_SITES: CardSite[] = [
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
    id: 'instagram',
    hosts: ['instagram.com', 'instagr.am'],
    // /p/, /reel/, /reels/ and /tv/. A /share/ link is resolved by the cleaner
    // first, so the card sees the permalink.
    match: (url) => /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/.exec(url.pathname),
    build: buildInstagramCard,
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
      // A public group post: /groups/<slug>/permalink/<id> or /posts/<id>.
      /^\/groups\/[^/]+\/(?:permalink|posts)\/(\d{6,})/.exec(url.pathname) ??
      /^\/[^/]+\/posts\/([0-9]{6,}|pfbid[0-9A-Za-z]{10,})/.exec(url.pathname) ??
      /^\/reel\/(\d{6,})/.exec(url.pathname) ??
      /^\/[^/]+\/videos\/(\d{6,})/.exec(url.pathname) ??
      (/^\/watch\/?$/.test(url.pathname) && url.searchParams.get('v')
        ? ['watch', url.searchParams.get('v')]
        : null) ??
      // A /share/p/ link often resolves to story.php; both name the post by
      // story_fbid, which is also what keeps two such posts apart.
      (/^\/(?:permalink|story)\.php$/.test(url.pathname) && url.searchParams.get('story_fbid')
        ? ['story', url.searchParams.get('story_fbid')]
        : null),
    build: buildFacebookCard,
  },
  {
    id: 'nhentai',
    hosts: ['nhentai.net'],
    // /g/<id>/ and /g/<id>/<slug>/.
    match: (url) => /^\/g\/(\d{1,9})(?:\/|$)/.exec(url.pathname),
    build: buildNhentaiCard,
  },
  {
    id: 'reddit',
    hosts: ['reddit.com', 'redd.it'],
    // Every form names the post by id: /r/<sub>/comments/<id>, /comments/<id>,
    // /gallery/<id> (what the share sheet gives), and /<id> on redd.it, which
    // redirects to /comments/<id>. Keyed on the id, so the same post sent twice
    // in two forms makes one card.
    match: (url) =>
      /\/comments\/([a-z0-9]{4,10})(?:\/|$)/i.exec(url.pathname) ??
      /^\/gallery\/([a-z0-9]{4,10})(?:\/|$)/i.exec(url.pathname) ??
      // The media hosts (i., v., preview.redd.it) are not post links.
      (url.hostname === 'redd.it' ? /^\/([a-z0-9]{4,10})(?:\/|$)/i.exec(url.pathname) : null),
    build: buildRedditCard,
  },
  {
    id: 'tiktok',
    hosts: ['tiktok.com'],
    // Photo posts (/@user/photo/<id>) are not covered: tikwm's shape for them
    // is unverified, and a card built on a guess is worse than a clean link.
    match: (url) => /^\/@([\w.-]{1,64})\/video\/(\d{6,})/.exec(url.pathname),
    build: buildTikTokCard,
  },
  {
    id: 'mangadex',
    hosts: ['mangadex.org'],
    // /title/<uuid> and /title/<uuid>/<slug>. Chapter links are not covered.
    match: (url) => /^\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(url.pathname),
    build: buildMangadexCard,
  },
];

/**
 * Shorthand a person types instead of a URL, e.g. `nh/693549`.
 *
 * These are not URLs, so extractUrls never sees them; each one expands to the
 * real link, which is what the reply shows. The pattern is case-insensitive
 * because this is typed text, not an identifier - but a match *inside* a URL
 * is dropped, so `example.com/docs/nh/123` never turns into a gallery.
 */
const SHORTHAND: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/\bnh\/#?(\d{1,9})\b/gi, (match) => `https://nhentai.net/g/${Number(match[1])}/`],
];

/** Every (from, href) pair worth looking at in a message. */
function candidateRefs(text: string, cleanedFor: Map<string, string>): Array<{ from: string; href: string }> {
  const urls = findUrls(text);
  const refs = urls.map(({ raw }) => ({ from: raw, href: cleanedFor.get(raw) ?? raw }));

  for (const [pattern, expand] of SHORTHAND) {
    for (const match of text.matchAll(pattern)) {
      // `.../nh/123` is part of a URL, not a shorthand someone typed.
      const start = match.index;
      // `||nh/123||` is hidden on purpose, exactly like a spoiled link.
      if (isSpoiled(text, start, start + match[0].length)) continue;
      if (urls.some(({ start: from, end }) => start >= from && start < end)) continue;
      refs.push({ from: match[0], href: expand(match) });
    }
  }
  return refs;
}

/** True when this text contains something a card could be built from. */
export function hasCardFor(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return candidateRefs(text, new Map()).some(({ href }) => locateCard(href) !== null);
}

/** The card site that owns one href, or null. */
function locateCard(href: string): CardHit | null {
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
  if (!site) return null;
  const match = site.match(url);
  return match ? { url, site, match } : null;
}

/**
 * Resolve one raw URL from the message to a card site.
 *
 * The cleaned URL wins: a shortener was resolved into the real target there,
 * and that target is what carries the id a card needs.
 */
function findCard(raw: string, cleanedFor: Map<string, string>, explicit?: string): CardHit | null {
  for (const href of [explicit, cleanedFor.get(raw), raw]) {
    if (!href) continue;
    const hit = locateCard(href);
    if (hit) return hit;
  }
  return null;
}

/**
 * Build preview cards for the links in a message.
 *
 * The cleaned results from cleanMessage let a card show the cleaned URL
 * rather than the tracked one.
 */
export async function buildCards(text: string, { cleaned = [], fetchImpl = fetch }: BuildCardsOptions = {}): Promise<Card[]> {
  const cleanedFor = new Map(cleaned.map(({ from, to }) => [from, to]));
  const seen = new Set<string>();
  const cards: Card[] = [];

  // Shared across every card in this message, because Discord counts them per
  // message and a rejected payload would cost the whole reply.
  let filesLeft = MAX_FILES;
  let bytesLeft = MAX_ATTACH_BYTES;
  let embedsLeft = MAX_EMBEDS;
  let charsLeft = MAX_EMBED_CHARS;

  for (const { from: raw, href } of candidateRefs(text, cleanedFor)) {
    if (cards.length >= MAX_CARDS) break;

    const hit = findCard(raw, cleanedFor, href);
    if (!hit) continue;
    const { url, site, match } = hit;

    const key = `${site.id}:${match.slice(1).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Notes and marks made while this card is built are filed under its URL.
    await withUrl(raw, async () => { try {
      const card = await site.build(
        { match, href: url.href },
        { fetchImpl, budget: { files: filesLeft, bytes: bytesLeft } },
      );
      if (!card) {
        mark('card', `${site.id}:none`);
        // Keep this: a card that silently does not appear is indistinguishable
        // from a link the bot did not recognise.
        note(`[card] ${site.id} produced nothing for ${url.href}`);
        return;
      }

      // A card is taken whole or not at all: a card with half its pages looks
      // broken, and Discord rejects the whole message past ten embeds or 6000
      // characters of embed text.
      const chars = card.embeds.reduce((total, embed) => total + embedChars(embed), 0);
      if (card.embeds.length > embedsLeft || card.files.length > filesLeft || chars > charsLeft) {
        note(`[card] ${site.id} skipped: message budget spent`);
        mark('card', `${site.id}:budget`);
        return;
      }

      cards.push({ from: raw, url: url.href, ...card });
      mark('card', site.id);
      mark('media', mediaOf(card));
      embedsLeft -= card.embeds.length;
      filesLeft -= card.files.length;
      charsLeft -= chars;
      bytesLeft -= card.files.reduce((total, file) => total + file.attachment.length, 0);
    } catch (error) {
      // A card is decoration, so the reply still goes out — but a swallowed
      // error is invisible in the log, so it is reported here.
      note(`[card] ${site.id} failed for ${raw}: ${(error as Error).message}`);
      mark('card', `${site.id}:error`);
    } });
  }

  return cards;
}

/**
 * What a card carries besides text, for the review: a video file, a video
 * link sent separately, a link Discord previews itself, images, or nothing.
 */
function mediaOf(card: BuiltCard): MediaKind {
  switch (card.video) {
    case 'attached':
      return 'video';
    case 'follow_up':
    case 'unfurl':
      return card.video;
    case undefined: {
      // An attached image (Pixiv pages, nhentai's spoilered cover) or an image
      // the embed points at: either way the card shows a picture.
      const images = Math.max(card.files.length, card.embeds.filter((embed) => embed.image).length);
      return images > 0 ? `images:${images}` : 'text';
    }
  }
}
