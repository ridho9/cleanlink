// Facebook: the post page is a login wall, but the public embed iframe at
// /plugins/post.php is not. It answers "unavailable" for posts that forbid
// embedding, which is simply no card.

import {
  authorBlock,
  attachMedia,
  playback,
  decodeEntities,
  getHtml,
  downloadMedia,
  downloadVideo,
  videoLinks,
  imageEmbeds,
  metaContent,
  metaContents,
  toField,
  FACEBOOK_BLUE,
  TIMEOUT_MS,
  UNFURL_UA,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';
import { note } from '../trace.ts';

/** Inner HTML of the div that starts at `from`, honouring nesting. */
function innerDiv(html: string, from: number): string | null {
  const open = html.indexOf('>', from);
  if (open === -1) return null;
  const start = open + 1;
  const end = matchingClose(html, 'div', start);
  return end === -1 ? null : html.slice(start, html.lastIndexOf('</', end));
}

/** The index just past the close tag of `tag`, counting nesting from `from`. */
function matchingClose(html: string, tag: string, from: number): number {
  let depth = 1;
  const pattern = new RegExp(`<\\/?${tag}\\b`, 'gi');
  pattern.lastIndex = from;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        const end = html.indexOf('>', match.index);
        return end === -1 ? -1 : end + 1;
      }
    } else {
      depth += 1;
    }
  }
  return -1;
}

/**
 * Drop every subtree marked `aria-hidden="true"`.
 *
 * A text-image post repeats its words in two layers: the visible span is
 * `aria-hidden`, and the absolutely positioned overlay that follows carries the
 * same text for a screen reader. Reading both put the sentence on the card
 * twice (measured 2026-11-12 on /share/18mbLjEsrz).
 */
function withoutHidden(html: string): string {
  let out = html;
  for (;;) {
    const open = /<([a-z][a-z0-9]*)\b[^>]*\baria-hidden="true"[^>]*>/i.exec(out);
    if (!open) return out;
    const end = matchingClose(out, open[1]!.toLowerCase(), open.index + open[0].length);
    if (end === -1) return out;
    out = out.slice(0, open.index) + out.slice(end);
  }
}

/**
 * The message div carries Facebook's own "see the full post" link, labelled in
 * the viewer's language ("Lihat lebih banyak", "See more"). A text scrape ends
 * the card with it, as if it were the author's last words (seen live
 * 2026-11-18), so it is cut by class, not by wording.
 */
const SEE_MORE_LINK = /<a\b[^>]*\bsee_more_link\b[^>]*>[\s\S]*?<\/a>/gi;

/** Turn the post body's paragraphs and links into plain text. */
function htmlToText(fragment: string): string {
  return decodeEntities(
    withoutHidden(fragment.replace(SEE_MORE_LINK, ''))
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

/** A rendition small enough that a larger one is worth a second request. */
const SMALL_RENDITION = /[?&]stp=dst-jpg_[ps]\d{1,3}x/;

/**
 * The post picture at the size it was uploaded.
 *
 * A link crawler is the only reader Facebook shows a post page to, and its
 * `og:image` is the upload, still behind a `ctp` crop parameter. Dropping that
 * parameter from the signed URL returns the file itself (measured 2026-11-09
 * on a `story.php` post: 600x807 with it, 1523x2048 without).
 */
async function fullSizePicture(href: string, options: CardOptions): Promise<string | null> {
  const page = await getHtml(href, {
    ...options,
    headers: { 'user-agent': UNFURL_UA },
  });
  if (!page) return null;

  const image = metaContent(page.html, 'og:image');
  // Both are the page's profile picture, not the post's own.
  if (!image || image.includes('s40x40') || image.includes('t39.30808-1')) return null;

  const url = new URL(image);
  url.searchParams.delete('ctp');
  return url.href;
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
          const embed: CardEmbed = {
            url: href,
            color: FACEBOOK_BLUE,
            footer: { text: 'Facebook' },
          };
          // The player's own frame is the picture; the author name is all the
          // page gave us. The sentence about the login wall is not true once
          // the file is here, so only the author is carried over.
          const author = blocked?.embeds[0]?.author;
          if (author) embed.author = author;
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
    // path that differs from the page that owns it. A legacy `story.php` or
    // `permalink.php` address names no handle — `pathname.split('/')[1]` would
    // read `story.php` as one — so the owner's id is the fallback.
    const via = new URL(href);
    const legacy = /^\/(?:story|permalink|photo|watch)\.php$/.test(via.pathname);
    const handle =
      /href="\/?([\w.-]+)\/posts\//.exec(page.html)?.[1] ??
      (legacy ? null : via.pathname.split('/')[1]);
    const owner = via.searchParams.get('id');
    const profile = handle
      ? `https://www.facebook.com/${handle}`
      : owner && /^\d+$/.test(owner)
        ? `https://www.facebook.com/profile.php?id=${owner}`
        : null;

    const images = postImages(page.html);
    // One picture in a rendition the embed cut down: the post page names the
    // upload, which is worth one more request. A post with several pictures is
    // left alone, because its `og:image` is one of them, not all of them.
    if (images.length === 1 && SMALL_RENDITION.test(images[0]!)) {
      const full = await fullSizePicture(href, options);
      if (full) images[0] = full;
    }

    const footer = { text: 'Facebook' };
    const embed: CardEmbed = {
      url: href,
      color: FACEBOOK_BLUE,
      footer,
      description: toField(text, 4096),
    };
    if (name) {
      embed.author = authorBlock(decodeEntities(name), handle ?? 'Facebook', {
        url: profile,
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
      const played = await attachMedia(await videoLinks(href), options);
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
async function fromFacebed(
  href: string,
  options: CardOptions,
  mirrored: MirrorPage | null,
): Promise<BuiltCard | null> {
  if (!mirrored) return null;
  const { page, mirror, embed } = mirrored;

  // A reel's `og:video` is the full file on Facebook's own CDN, usually past
  // the upload budget (a 17 s reel measured 24 MB).
  const video = metaContent(page.html, 'og:video');
  const media = video ? await downloadMedia(video, options) : { files: null, refused: [] };

  // The file answered but would not fit, and the CDN URL does not unfurl when
  // posted alone (measured: no embed). The page does, so the page is the link
  // that gets shown - one message, one player, and no caption twice.
  if (!media.files && media.refused.length > 0) {
    return { url: mirror.href, embeds: [], files: [], video: 'unfurl' };
  }

  if (media.files) return { embeds: [embed], files: media.files, video: 'attached' };

  // A post with several pictures names each in its own `og:image`, in post order.
  const images = metaContents(page.html, 'og:image');
  if (images[0]) embed.image = { url: images[0] };
  return { embeds: [embed, ...imageEmbeds(href, FACEBOOK_BLUE, embed.footer, images.slice(1))], files: [] };
}

/**
 * Fetch the facebed page and build the text part of a card from its tags.
 *
 * The mirror fetches the post on our behalf, which measured 1-7 s: by default
 * a budget of its own, so the fallback is not cut off mid-fetch.
 */
async function facebedPage(href: string, options: CardOptions, timeout = 15_000): Promise<MirrorPage | null> {
  const url = new URL(href);
  if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;

  const mirror = new URL(url.href);
  mirror.hostname = 'www.facebed.com';

  // Facebed only serves its tags to a link crawler; to a browser it bounces
  // straight back to Facebook, and the wall's tags are the generic ones. This
  // is the agent of the consumer the tags are for.
  const page = await getHtml(mirror.href, {
    ...options,
    headers: { 'user-agent': UNFURL_UA },
    timeout,
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
 *
 * The page names one `og:image` however many pictures the post has (measured
 * 2026-11-16: one of two), and nothing on it says there are more. The mirror
 * names them all, so the caller asks it at the same time as the page: the
 * mirror's list is used when it is the longer one.
 */
function groupCard(html: string, href: string, mirrored: MirrorPage | null): BuiltCard | null {
  const name = metaContent(html, 'og:title');
  const text = metaContent(html, 'og:description');
  // The wall has no description, and its title is just "Facebook".
  if (!name || !text || /^Facebook$/.test(name)) return null;

  const group = /^(.+?) \| /.exec(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '')?.[1] ?? null;
  const slug = /^\/groups\/([^/]+)\//.exec(new URL(href).pathname)?.[1];
  const footer = { text: 'Facebook' };
  const embed: CardEmbed = {
    url: href,
    color: FACEBOOK_BLUE,
    footer,
    description: toField(text, 4096),
  };
  if (group) {
    embed.author = authorBlock(decodeEntities(group), null, {
      url: slug && `https://www.facebook.com/groups/${slug}/`,
    });
  }
  const own = metaContents(html, 'og:image');
  const pictures = mirrored ? metaContents(mirrored.page.html, 'og:image') : [];
  const images = pictures.length > own.length ? pictures : own;
  if (images[0]) embed.image = { url: images[0] };
  return { embeds: [embed, ...imageEmbeds(href, FACEBOOK_BLUE, footer, images.slice(1))], files: [] };
}

/** The mirror's page, its address, and the card text built from its tags. */
interface MirrorPage {
  page: { status: number; html: string };
  mirror: URL;
  embed: CardEmbed;
}

async function buildFacebookCard(input: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  // A group post is the one layout the embed iframe never answers: it says
  // "Unavailable" for every public group post. The page itself does answer,
  // and the mirror is asked at once for the pictures the page leaves out - in
  // the usual request budget, so a slow mirror costs the other pictures, not
  // the card. A post that turns out to be walled reuses that answer below.
  let mirrored: MirrorPage | null | undefined;
  /** The mirror is asked at most once per post: every branch shares its answer. */
  const mirrorOnce = async (): Promise<MirrorPage | null> => {
    if (mirrored === undefined) mirrored = await facebedPage(input.href, options);
    return mirrored;
  };

  if (/^\/groups\//.test(new URL(input.href).pathname)) {
    const [page, mirror] = await Promise.all([
      getHtml(input.href, options),
      facebedPage(input.href, options, TIMEOUT_MS),
    ]);
    mirrored = mirror;
    const group = page && groupCard(page.html, input.href, mirror);
    if (group && hasContent(group)) return group;
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
      const fromMirror = await mirrorOnce();
      if (fromMirror) card.embeds[0] = { ...fromMirror.embed, ...embed, ...pick(fromMirror.embed) };
    }
    return card;
  }

  // A card that only describes a video it could not play is the weaker answer;
  // ask the mirror before settling for it.
  if (!card || card.degraded || !hasContent(card)) {
    const fallback = await fromFacebed(input.href, options, await mirrorOnce());
    if (fallback) return fallback;
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
