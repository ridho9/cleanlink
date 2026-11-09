// Reddit: the post page answers a bare "Mozilla/5.0" with 403, and the JSON
// endpoints answer an anonymous reader with 403 too. The Atom feed of the post
// does answer: title, author, preview picture and the outbound media link. A
// video post's link is v.redd.it, whose HLS playlist is the only anonymous
// rendition (the DASH mp4 files answer 403).

import {
  authorBlock,
  decodeEntities,
  downloadVideo,
  getHtml,
  toField,
  REDDIT_ORANGE,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

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
};

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

  if (!title && !picture && !media) return null;
  return { title, author, picture, media };
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

  // A video post links v.redd.it; its HLS playlist is what an anonymous reader
  // may fetch. A picture post links i.redd.it, which is the picture itself.
  const videoId = /^https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/i.exec(post.media ?? '')?.[1] ?? null;
  const files = videoId
    ? await downloadVideo(`https://v.redd.it/${videoId}/HLSPlaylist.m3u8`, options, REDDIT_FORMAT)
    : null;

  const image = files ? null : (/^https?:\/\/i\.redd\.it\//i.test(post.media ?? '') ? post.media : post.picture);
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

  return { embeds: [embed], files: files ?? [], ...(files ? { video: 'attached' as const } : {}) };
}

export { buildRedditCard };
