// Threads: the page carries the post as JSON in its `application/json`
// scripts: author, avatar, text, media, counts, and the post it replies to or
// quotes. It is served only to a browser user agent — Discordbot gets a shell
// with no data at all. When the JSON is missing or changed shape, the card
// falls back to the page's og: tags.

import {
  attachMedia,
  authorBlock,
  clip,
  escapeMarkdown,
  getHtml,
  metaContent,
  playback,
  statFields,
  THREADS_BLACK,
  toField,
} from './shared.ts';
import type { BuiltCard, CardEmbed, CardInput, CardOptions } from './shared.ts';

/** Threads allows 20 items per carousel; Discord allows 10 embeds a message. */
const MAX_IMAGES = 10;

/** Instagram's profile-photo buckets end in `-19` (`t51.2885-19`, `t51.82787-19`); post media does not. */
const AVATAR = /\/t\d+\.\d+-19\//;

interface ThreadsMedia {
  image_versions2?: { candidates?: { url?: string }[] } | null;
  video_versions?: { url?: string }[] | null;
}

interface ThreadsUser {
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
}

interface ThreadsPost extends ThreadsMedia {
  pk?: string;
  code?: string;
  user?: ThreadsUser;
  caption?: { text?: string } | null;
  taken_at?: number;
  like_count?: number;
  carousel_media?: ThreadsMedia[] | null;
  text_post_app_info?: {
    is_reply?: boolean;
    reply_to_author?: ThreadsUser | null;
    direct_reply_count?: number;
    repost_count?: number;
    quote_count?: number;
    share_info?: { quoted_post?: ThreadsPost | null } | null;
  } | null;
}

async function buildThreadsCard({ match, href }: CardInput, options: CardOptions): Promise<BuiltCard | null> {
  const page = await getHtml(href, options);
  if (!page) return null;

  const code = match[2];
  const found = code ? findThread(page.html, code) : null;
  if (found) return postCard(found.post, found.parent, href, options);
  return ogCard(page.html, href);
}

/** The card built from the post's JSON, laid out like the X card. */
async function postCard(post: ThreadsPost, parent: ThreadsPost | null, href: string, options: CardOptions): Promise<BuiltCard | null> {
  const info = post.text_post_app_info ?? {};
  const quoted = info.share_info?.quoted_post ?? null;
  const url = post.user?.username && post.code ? `https://www.threads.com/@${post.user.username}/post/${post.code}` : href;

  // The post's own media first. A post without media shows the quoted post's,
  // then the parent's: a one-line reply makes sense only next to the picture
  // it answers.
  const source = [post, quoted, parent].find((item): item is ThreadsPost =>
    Boolean(item && (item.carousel_media?.length || item.video_versions?.length || item.image_versions2?.candidates?.length)));
  const played = await attachMedia(source ? videoUrls(source) : null, options);
  const playing = played.kind !== 'none';
  const images = source ? stills(source, playing).slice(0, MAX_IMAGES) : [];

  const parts = [];
  if (post.caption?.text) parts.push(escapeMarkdown(post.caption.text));
  if (quoted) parts.push(contextBlock('Quoting', quoted.user, quoted));
  else if (info.is_reply) parts.push(contextBlock('Replying to', parent?.user ?? info.reply_to_author, parent));
  // Without text there is nothing this card adds over Discord's own preview.
  if (parts.length === 0 && images.length === 0 && !playing) return null;

  const embed: CardEmbed = {
    url,
    color: THREADS_BLACK,
    author: authorBlock(who(post.user), 'Threads', {
      url: post.user?.username ? `https://www.threads.com/@${post.user.username}` : null,
      iconUrl: post.user?.profile_pic_url,
    }),
    footer: { text: 'Threads' },
  };
  if (parts.length > 0) embed.description = clip(parts.join('\n\n'), 4096);
  if (images[0]) embed.image = { url: images[0] };
  if (post.taken_at) embed.timestamp = new Date(post.taken_at * 1000).toISOString();

  const fields = statFields([
    ['Replies', info.direct_reply_count],
    ['Reposts', info.repost_count],
    ['Quotes', info.quote_count],
    ['Likes', post.like_count],
  ]);
  if (fields) embed.fields = fields;

  // Embeds that share a URL show as one gallery in Discord.
  if (images.length > 1) embed.footer = { text: `Threads · 1/${images.length}` };
  const embeds = [
    embed,
    ...images.slice(1).map((image, index) => ({
      url,
      color: THREADS_BLACK,
      image: { url: image },
      footer: { text: `Threads · ${index + 2}/${images.length}` },
    })),
  ];
  return { embeds, ...playback(played) };
}

/** The card built from og: tags alone: author, text and one image. */
function ogCard(html: string, href: string): BuiltCard | null {
  const description = metaContent(html, 'og:description');
  if (!description) return null;

  const title = metaContent(html, 'og:title') ?? 'Threads';
  const embed: CardEmbed = {
    url: metaContent(html, 'og:url') ?? href,
    color: THREADS_BLACK,
    author: authorBlock(title.replace(/\s+on Threads$/i, '').trim(), 'Threads', { url: href }),
    description: toField(description, 4096),
    footer: { text: 'Threads' },
  };

  // A text-only post still has an og:image: the author's avatar. That belongs
  // in the corner, not across the card.
  const image = metaContent(html, 'og:image');
  if (image) {
    if (AVATAR.test(image)) embed.thumbnail = { url: image };
    else embed.image = { url: image };
  }
  return { embeds: [embed], files: [] };
}

/** `Name (@handle)`, with whichever of the two exists. */
function who(user: ThreadsUser | null | undefined): string {
  return [user?.full_name, user?.username ? `(@${user.username})` : ''].filter(Boolean).join(' ');
}

/** A quoted or parent post as a block quote under the post text. */
function contextBlock(label: string, user: ThreadsUser | null | undefined, post: ThreadsPost | null): string {
  const head = `> **${label} ${escapeMarkdown(who(user) || 'a post')}**`;
  const text = post?.caption?.text;
  if (!text) return head;
  const body = text.split('\n').map((line) => `> ${escapeMarkdown(line)}`).join('\n');
  return `${head}\n${body}`;
}

/** The video renditions of a single-video post, best first. Carousels give poster frames only. */
function videoUrls(post: ThreadsPost): string[] | null {
  if (post.carousel_media?.length) return null;
  // Threads often lists the same URL under several rendition types.
  const urls = [...new Set((post.video_versions ?? []).map((item) => item.url).filter((url): url is string => Boolean(url)))];
  return urls.length > 0 ? urls : null;
}

/**
 * Every image of a post, largest rendition first in each list. A video item
 * gives its poster frame, unless the video itself is attached.
 */
function stills(post: ThreadsPost, playing: boolean): string[] {
  const items = post.carousel_media?.length ? post.carousel_media : [post];
  return items
    .filter((item) => !(playing && item.video_versions?.length))
    .map((item) => item.image_versions2?.candidates?.[0]?.url)
    .filter((url): url is string => Boolean(url));
}

/**
 * Post `code` and the post it replies to, from the page's JSON scripts.
 *
 * The page holds the post, its replies, and a `containing_thread` whose last
 * edge is the direct parent. The thread is keyed by the post's `pk`, in a
 * script that does not repeat the post's code.
 */
function findThread(html: string, code: string): { post: ThreadsPost; parent: ThreadsPost | null } | null {
  const scripts: unknown[] = [];
  for (const [, json] of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!json!.includes('"code"') && !json!.includes('"containing_thread"')) continue;
    try {
      scripts.push(JSON.parse(json!));
    } catch {
      // A script that is not JSON is not the post.
    }
  }

  let post: ThreadsPost | null = null;
  for (const data of scripts) {
    post = findNode(data, (node) => node.code === code && Boolean(node.user)) as ThreadsPost | null;
    if (post) break;
  }
  if (!post) return null;

  let parent: ThreadsPost | null = null;
  if (post.text_post_app_info?.is_reply && post.pk) {
    const pk = post.pk;
    for (const data of scripts) {
      const holder = findNode(data, (node) => node.pk === pk && threadEdges(node).length > 0);
      const edges = holder ? threadEdges(holder) : [];
      parent = edges.at(-1)?.node ?? null;
      if (parent) break;
    }
  }
  return { post, parent };
}

type ThreadEdges = { node?: ThreadsPost }[];

function threadEdges(node: Record<string, unknown>): ThreadEdges {
  const info = node.text_post_app_info as { containing_thread?: { posts?: { edges?: ThreadEdges } } } | undefined;
  return info?.containing_thread?.posts?.edges ?? [];
}

function findNode(node: unknown, test: (record: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record) && test(record)) return record;
  for (const value of Object.values(record)) {
    const found = findNode(value, test);
    if (found) return found;
  }
  return null;
}

export { buildThreadsCard };
