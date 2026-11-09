// Reddit: the post page answers a bare "Mozilla/5.0" with 403, and the JSON
// endpoints answer an anonymous reader with 403 too. The Atom feed of the post
// does answer: title, author, preview picture and the outbound media link. A
// gallery post names only its gallery page there, which the embed view renders
// in full. A video post's link is v.redd.it, whose HLS playlist is the only
// anonymous rendition (the DASH mp4 files answer 403).

import {
  authorBlock,
  decodeEntities,
  downloadVideo,
  getHtml,
  imageEmbeds,
  MAX_EMBEDS,
  toField,
  REDDIT_ORANGE,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';
import { note } from '../trace.ts';

/** Reddit's own request policy asks every client to name itself. */
export const REDDIT_UA = 'cleanlink/1.0 (+https://github.com/ridho9/cleanlink)';

// HLS offers one file per rendition with the sound in a separate group, so the
// selector has to take whatever yt-dlp can pair up.
const REDDIT_FORMAT = 'bestvideo*+bestaudio/best';

type RedditPost = {
  title: string;
  author: string | null;
  picture: string | null;
  media: string | null;
  gallery: string | null;
};

/** The width a preview URL asks Reddit for; the widest one is the biggest copy. */
function previewWidth(url: string): number {
  return Number(/[?&]width=(\d+)/.exec(url)?.[1] ?? 0);
}

/**
 * The uploaded file behind a gallery preview.
 *
 * A gallery picture is served from `preview.redd.it/<slug>-v0-<media>.<ext>`
 * with a signature in the query, while the same media id answers unsigned on
 * `i.redd.it`. The original keeps its own size; the preview is the 1080 px
 * rendition.
 */
function originalPicture(preview: string): string | null {
  const media = /-v0-([a-z0-9]+)\.(jpe?g|png|gif|webp)$/i.exec(new URL(preview).pathname);
  return media ? `https://i.redd.it/${media[1]}.${media[2]}` : null;
}

/**
 * Gallery pictures, in the order the post shows them.
 *
 * The post page is a login wall, but the embed view renders every page of a
 * gallery: one `<li slot="page-N">` per picture, each carrying its own preview
 * set. The page's first preview names the picture; the widest preview of that
 * same media id is the largest copy the page offers.
 */
function galleryPictures(html: string): string[] {
  const previews = [...html.matchAll(/https:\/\/preview\.redd\.it\/[^"\\ <]+/g)]
    .map((match) => decodeEntities(match[0]));
  const starts = [...html.matchAll(/<li slot="page-(\d+)"/g)]
    .map((match) => ({ page: Number(match[1]), at: match.index ?? 0 }))
    .sort((a, b) => a.page - b.page);

  const pictures: string[] = [];
  for (const [index, { at }] of starts.entries()) {
    const page = html.slice(at, starts[index + 1]?.at ?? html.length);
    const media = /-v0-([a-z0-9]+)\./.exec(/https:\/\/preview\.redd\.it\/[^"\\ <]+/.exec(page)?.[0] ?? '')?.[1];
    if (!media) continue;
    const widest = previews
      .filter((url) => url.includes(`-v0-${media}.`))
      .reduce((best, url) => (previewWidth(url) > previewWidth(best) ? url : best), '');
    const picture = widest ? originalPicture(widest) : null;
    if (picture && !pictures.includes(picture)) pictures.push(picture);
  }
  return pictures;
}

/**
 * The one entry of a post's Atom feed.
 *
 * The feed carries no score and no body: an anonymous reader cannot have them.
 * It does carry the outbound media link, which is what tells a video post from
 * a picture post and names the video.
 */
function feedEntry(xml: string): RedditPost | null {
  // The entry's HTML part is escaped twice over (`&amp;quot;` for a quote), so
  // the anchors are only readable after one decode.
  const entry = decodeEntities(/<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1] ?? '');
  if (!entry) return null;

  const title = (/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '').trim();
  const author = /\/u\/([A-Za-z0-9_-]{3,20})/.exec(entry)?.[1] ?? null;
  const picture = /<media:thumbnail[^>]+url="([^"]+)"/.exec(entry)?.[1] ?? null;

  // The entry links the post, the author and the subreddit, then the outbound
  // media as `[link]`. Only that last one leaves reddit.com.
  const media =
    [...entry.matchAll(/href="([^"]+)"/g)]
      .map((match) => decodeEntities(match[1]))
      .find((href) => /^https?:\/\/(?:[a-z0-9-]+\.)*redd\.it\//i.test(href)) ?? null;

  // A gallery post links its gallery page instead of a file.
  const gallery = /\/gallery\/([a-z0-9]+)/i.exec(entry)?.[1] ?? null;

  if (!title && !picture && !media) return null;
  return { title, author, picture, media, gallery };
}

/**
 * The embed view of a gallery.
 *
 * The page is the only source that renders every gallery page, so a rate limit
 * gets one more try; anything else is noted with its status, because the feed
 * alone cannot say why the pictures are missing.
 */
async function galleryPage(permalink: URL, options: CardOptions): Promise<string> {
  const url = `https://embed.reddit.com${permalink.pathname}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': REDDIT_UA, accept: 'text/html' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return await res.text();
      note(`[reddit] gallery page answered ${res.status}`);
      if (res.status !== 429) break;
    } catch (error) {
      note(`[reddit] gallery page failed: ${(error as Error).message}`);
      break;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1000);
    await promise;
  }
  return '';
}

async function buildRedditCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const subreddit = match[1] ?? null;
  const url = new URL(href);
  const feed = `${url.origin}${url.pathname.replace(/\/?$/, '/')}.rss`;

  const page = await getHtml(feed, {
    ...options,
    headers: { 'user-agent': REDDIT_UA },
  });
  if (!page) return null;
  const post = feedEntry(page.html);
  if (!post) return null;

  // A gallery post links its gallery page, which an anonymous reader cannot
  // open; the embed view renders every page of it. A picture inside the gallery
  // keeps its own size, so the card shows the whole set.
  const pictures = post.gallery
    ? galleryPictures(await galleryPage(url, options)).slice(0, MAX_EMBEDS)
    : [];

  // A video post links v.redd.it; its HLS playlist is what an anonymous reader
  // may fetch. A picture post links i.redd.it, which is the picture itself.
  const videoId = /^https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/i.exec(post.media ?? '')?.[1] ?? null;
  const files = videoId
    ? await downloadVideo(`https://v.redd.it/${videoId}/HLSPlaylist.m3u8`, options, REDDIT_FORMAT)
    : null;

  const image = files
    ? null
    : pictures[0] ?? (/^https?:\/\/i\.redd\.it\//i.test(post.media ?? '') ? post.media : post.picture);
  const where = [subreddit && `r/${subreddit}`, post.author && `u/${post.author}`].filter(Boolean).join(' · ');

  const embed: CardEmbed = {
    url: href,
    color: REDDIT_ORANGE,
    author: authorBlock(where, 'Reddit', {
      url: post.author ? `https://www.reddit.com/user/${post.author}` : null,
    }),
    footer: { text: 'Reddit' },
  };
  if (post.title) embed.title = toField(post.title, 256);
  // The attached player brings its own frame, so the preview picture stays out.
  if (image) embed.image = { url: image };

  const embeds = [embed, ...imageEmbeds(href, REDDIT_ORANGE, embed.footer, pictures.slice(1))];
  return { embeds, files: files ?? [], ...(files ? { video: 'attached' as const } : {}) };
}

export { buildRedditCard };
