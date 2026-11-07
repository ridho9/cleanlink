// Facebook: the post page is a login wall, but the public embed iframe at
// /plugins/post.php is not. It answers "unavailable" for posts that forbid
// embedding, which is simply no card.

import {
  authorBlock,
  attachMedia,
  playback,
  decodeEntities,
  getHtml,
  downloadVideo,
  videoLinks,
  imageEmbeds,
  metaContent,
  toField,
  FACEBOOK_BLUE,
  UNFURL_UA,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';
import { note } from '../trace.ts';

/** Inner HTML of the div that starts at `from`, honouring nesting. */
function innerDiv(html: string, from: number): string | null {
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
function htmlToText(fragment: string): string {
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

/**
 * The page-feed layout, used by Facebook for some posts.
 *
 * It is a different DOM: `role="feed"` instead of `data-testid="post_message"`,
 * the author name only in the avatar's `aria-label`, and the post identified by
 * the link the widget carries back to itself. Only accepted when that link
 * names the post we asked for, so a feed showing something else is not carded.
 */
function feedCard(html: string, match: CardInput['match'], href: string): BuiltCard | null {
  if (!html.includes('role="feed"')) return null;

  const id = match[1];
  const link = /href="\/([\w.-]+)\/posts\/([0-9A-Za-z]+)/.exec(html);
  if (!link || link[2] !== id) return null;

  const name = /aria-label="([^"]+)"/.exec(html)?.[1];
  const text = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
    .map((paragraph) => htmlToText(paragraph[1]))
    .filter(Boolean)
    .join('\n\n');

  const footer = { text: 'Facebook' };
  const embed: CardEmbed = { url: href, color: FACEBOOK_BLUE, footer };
  if (name) {
    embed.author = authorBlock(decodeEntities(name), link[1], {
      url: `https://www.facebook.com/${link[1]}`,
    });
  }
  if (text) embed.description = toField(text, 4096);

  const images = mediaImages(html);
  if (images[0]) embed.image = { url: images[0] };

  return {
    embeds: [embed, ...imageEmbeds(href, FACEBOOK_BLUE, footer, images.slice(1))],
    files: [],
  };
}

/**
 * The layout Facebook returns for a video it will not play without a session.
 *
 * There is no media to show, only the page name, so the card says what it knows
 * and no more: who posted it, and that the video needs a logged-in viewer.
 */
function blockedVideoCard(html: string, href: string): BuiltCard | null {
  if (!/Video (?:tidak tersedia|isn't available)/i.test(html)) return null;

  const avatar = [...html.matchAll(/<img\b[^>]*>/gi)].find((tag) => tag[0].includes('role="img"'));
  const name = avatar ? /aria-label="([^"]+)"/.exec(avatar[0])?.[1] : null;
  if (!name) return null;

  return {
    embeds: [{
      url: href,
      color: FACEBOOK_BLUE,
      author: authorBlock(decodeEntities(name), 'Facebook', {
        url: 'https://www.facebook.com',
      }),
      description: 'Facebook will not play this video for a viewer who is not logged in.',
      footer: { text: 'Facebook' },
    }],
    files: [],
  };
}

/**
 * Download an unplayable Facebook video with yt-dlp and attach it.
 *
 * Facebook serves the player only to a browser that runs its JavaScript, so an
 * anonymous fetch sees "this video cannot be played" while a logged-out browser
 * plays it fine. yt-dlp speaks the same API and can hand back the file.
 *
 * Optional by design: no yt-dlp, a video it cannot parse, or a file larger than
 * the message budget all mean no attachment, and the caller falls back to the
 * author-only card. Nothing here is on the path for any other site.
 */
function isVideoPath(href: string): boolean {
  return /\/(?:reel|videos|watch)\b/.test(new URL(href).pathname);
}

/** Post thumbnails from the grid: everything on scontent that is not an avatar. */
function mediaImages(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/https:\/\/scontent[^"\\ ]+/g)]
        .map((match) => decodeEntities(match[0]))
        // `s40x40` is the avatar at thumbnail size, `t39.30808-1` the same
        // picture at full size. Both are the page, not the post.
        .filter((url) => !url.includes('s40x40') && !url.includes('/t39.30808-1/')),
    ),
  ];
}

/**
 * The post's pictures at the size they were uploaded.
 *
 * The grid is built from `s394x394` thumbnails, but the same page repeats every
 * picture in a JSON-LD block with its original dimensions and a URL that
 * carries no size transform. Reading it costs no extra request.
 */
function jsonLdImages(html: string): string[] {
  const images: string[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: { image?: unknown };
    try {
      data = JSON.parse(block[1]) as { image?: unknown };
    } catch {
      continue;
    }
    for (const image of [data.image].flat()) {
      const url = (image as { contentUrl?: unknown } | null)?.contentUrl;
      if (typeof url === 'string' && /^https:\/\/scontent[./]/.test(url)) images.push(url);
    }
  }
  return [...new Set(images)];
}

/**
 * The post's pictures in post order: the full picture where the page names one,
 * the thumbnail where it does not.
 *
 * Only the single-post iframe is read this way. A page-feed widget can carry a
 * JSON-LD block for a different post in the feed, so `feedCard` keeps its own
 * grid thumbnails.
 */
function postImages(html: string): string[] {
  const thumbnails = mediaImages(html);
  const full = jsonLdImages(html);
  if (full.length === 0) return thumbnails;

  // The uploader's file name is the one part every rendition shares.
  const file = /\/v\/[^/]+\/([^/?]+)/;
  const byKey = new Map(full.map((url) => [file.exec(url)?.[1], url] as [string | undefined, string]));
  const upgraded = thumbnails.map(
    (thumbnail) => byKey.get(file.exec(thumbnail)?.[1] ?? '') ?? thumbnail,
  );
  return [...new Set([...upgraded, ...full])];
}

async function fromEmbedPage({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
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
      // Some posts come back as a page-feed widget instead of a single-post
      // embed. The requested id is still in it, linked from the widget, so the
      // card is built from that layout rather than dropped.
      const feed = feedCard(page.html, match, href);
      if (feed) return feed;

      // A video that Facebook will not play for an anonymous viewer still
      // names its owner, and yt-dlp can often still reach the file. Discord's
      // own preview for such a link is the generic "Log in or sign up to view".
      const blocked = blockedVideoCard(page.html, href);

      // Only spend the yt-dlp call on a video: either the blocked-player
      // layout said so, or the link is a video path and the post was refused.
      const refused = /tidak tersedia|isn't available|is not available/i.test(page.html);
      if (blocked || refused) {
        const files = await downloadVideo(href, options);
        if (files) {
          const embed = {
            url: href,
            color: FACEBOOK_BLUE,
            footer: { text: 'Facebook' },
          };
          // The player's own frame is the picture; the author name is all the
          // page gave us.
          Object.assign(embed, blocked?.embeds[0] ?? {});
          return { embeds: [embed], files, video: 'attached' };
        }
      }
      // The layout named the video but no player could be had. Handed back as
      // degraded so the caller can try the mirror before settling for it.
      if (blocked) return { ...blocked, degraded: true };

      // Say why, as far as the answer allows: an anonymous request cannot tell
      // a deleted post from a private one or an age-restricted one — Facebook
      // returns the same "no longer available" page for all three, and the
      // words "age" and "login" appear in every response's scripts.
      note(
        `[card] facebook ${page.status} ${page.html.length}B attempt ${attempt + 1}: ` +
          (refused ? 'post unavailable (deleted, private, or age-restricted)' : 'unexpected response'),
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

    const images = postImages(page.html);

    const footer = { text: 'Facebook' };
    const embed: CardEmbed = {
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

    // A reel or a video post shows a poster frame here. The video itself is
    // better when it can be had, so try yt-dlp and drop the poster when the
    // attachment lands — the player brings its own frame.
    if (isVideoPath(href)) {
      const files = await downloadVideo(href, options);
      if (files) {
        delete embed.image;
        return { embeds: [embed], files, video: 'attached' };
      }

      // No merged file fits. A single-file rendition may still fit, or play
      // as a follow-up: Discord unfurls it when it arrives on its own. The URLs
      // are signed and expire, so they are only worth sending straight away.
      const played = await attachMedia(await videoLinks(href, options), options);
      if (played.kind !== 'none') {
        delete embed.image;
        return { embeds: [embed], ...playback(played) };
      }

      return { embeds, files: [], degraded: true };
    }

    return { embeds, files: [] };
  }

  return null;
}

/**
 * A card is worth the round trip only when it shows something. An empty embed
 * (a login-walled post the iframe answered with no text) is not.
 */
function hasContent(card: BuiltCard | null): boolean {
  if (!card) return false;
  if (card.files.length > 0) return true;
  return card.embeds.some(
    (embed) => embed.image || embed.description || embed.author || embed.title,
  );
}

/**
 * Facebed mirrors a Facebook page for link unfurlers - https://www.facebed.com
 * says the rewrite is `facebook.com` -> `facebed.com`. For a crawler user agent
 * it serves the post's OpenGraph tags, video included, where Facebook itself
 * serves a login wall; for a browser it bounces straight back to Facebook.
 *
 * It is read for its tags, not trusted as the link: the message keeps the clean
 * Facebook URL, so a reader never clicks through a third party.
 */
async function fromFacebed(href: string, options: CardOptions): Promise<BuiltCard | null> {
  const mirrored = await facebedPage(href, options);
  if (!mirrored) return null;
  const { page, mirror, embed } = mirrored;

  // A reel's `og:video` is the full file on Facebook's own CDN, usually past
  // the upload budget (a 17 s reel measured 24 MB).
  const played = await attachMedia(metaContent(page.html, 'og:video'), options);
  const image = metaContent(page.html, 'og:image');
  if (played.kind === 'none' && image) embed.image = { url: image };

  // The file would not fit, and the CDN URL does not unfurl when posted alone
  // (measured: no embed). The page does, so the page is the link that gets
  // shown - one message, one player, and no caption twice.
  if (played.kind === 'follow_up') return { url: mirror.href, embeds: [], files: [], video: 'unfurl' };

  return { embeds: [embed], ...playback(played) };
}

/** Fetch the facebed page and build the text part of a card from its tags. */
async function facebedPage(href: string, options: CardOptions) {
  const url = new URL(href);
  if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;

  const mirror = new URL(url.href);
  mirror.hostname = 'www.facebed.com';

  // Facebed only serves its tags to a link crawler; to a browser it bounces
  // straight back to Facebook, and the wall's tags are the generic ones. This
  // is the agent of the consumer the tags are for.
  // The mirror fetches the post on our behalf, which measured 1-7 s: a budget
  // of its own, so the fallback is not cut off mid-fetch.
  const page = await getHtml(mirror.href, {
    ...options,
    headers: { 'user-agent': UNFURL_UA },
    timeout: 15_000,
  });
  if (!page) return null;

  // Facebed passes the wall through when it cannot fetch the post either, and
  // the wall's tags are the generic ones.
  const title = metaContent(page.html, 'og:title');
  const description = metaContent(page.html, 'og:description') ?? '';
  if (!title || /^Log in or sign up/i.test(title)) return null;

  const handle = /facebook\.com\/([^/?#]+)/.exec(metaContent(page.html, 'og:url') ?? '')?.[1];
  const footer = { text: 'Facebook' };
  const embed: CardEmbed = {
    url: href,
    color: FACEBOOK_BLUE,
    footer,
    author: authorBlock(title, handle, { url: handle && `https://www.facebook.com/${handle}` }),
  };
  if (description) embed.description = toField(description, 4096);
  return { page, mirror, embed };
}

/**
 * A group post. The embed iframe refuses these ("Unavailable"), but the group
 * post page answers a plain browser request with the post's tags - the login
 * wall covers a page's posts, not a public group's. Measured 2026-11-07:
 * `og:title` is the post text plus " | Facebook", `og:description` is the text
 * alone, and the `<title>` is "<group> | <post text>".
 */
async function fromGroupPage(href: string, options: CardOptions): Promise<BuiltCard | null> {
  const page = await getHtml(href, options);
  if (!page) return null;

  const name = metaContent(page.html, 'og:title');
  const text = metaContent(page.html, 'og:description');
  // The wall has no description, and its title is just "Facebook".
  if (!name || !text || /^Facebook$/.test(name)) return null;

  const group = /^(.+?) \| /.exec(/<title>([^<]*)<\/title>/i.exec(page.html)?.[1] ?? '')?.[1] ?? null;
  const slug = /^\/groups\/([^/]+)\//.exec(new URL(href).pathname)?.[1];
  const embed: CardEmbed = {
    url: href,
    color: FACEBOOK_BLUE,
    footer: { text: 'Facebook' },
    description: toField(text, 4096),
  };
  if (group) {
    embed.author = authorBlock(decodeEntities(group), null, {
      url: slug && `https://www.facebook.com/groups/${slug}/`,
    });
  }
  const image = metaContent(page.html, 'og:image');
  if (image) embed.image = { url: image };
  return { embeds: [embed], files: [] };
}

async function buildFacebookCard(input: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  // A group post is the one layout the embed iframe never answers: it says
  // "Unavailable" for every public group post. The page itself does answer.
  if (/^\/groups\//.test(new URL(input.href).pathname)) {
    const group = await fromGroupPage(input.href, options);
    if (hasContent(group)) return group;
  }

  const card = await fromEmbedPage(input, options);

  // A player in the message beats any mirror: one message, no unfurl needed.
  const plays = card && (card.video === 'attached' || card.video === 'follow_up');
  if (plays) {
    // A refused reel that yt-dlp still fetched carries the video and nothing
    // else: the plugin page has no author or caption. Facebed's tags have
    // both, so they fill in the text; our file stays the player.
    const [embed] = card.embeds;
    if (embed && !embed.author && !embed.description) {
      const mirrored = await facebedPage(input.href, options);
      if (mirrored) card.embeds[0] = { ...mirrored.embed, ...embed, ...pick(mirrored.embed) };
    }
    return card;
  }

  // A card that only describes a video it could not play is the weaker answer;
  // ask the mirror before settling for it.
  if (!card || card.degraded || !hasContent(card)) {
    const mirrored = await fromFacebed(input.href, options);
    if (mirrored) return mirrored;
  }

  // A mirror that cannot fetch the post either leaves an empty embed, which is
  // a blank box in the channel - no card is better.
  return hasContent(card) ? card : null;
}

/** The text fields of a card embed. */
function pick({ author, description }: CardEmbed) {
  return { ...(author && { author }), ...(description && { description }) };
}

export { buildFacebookCard };
