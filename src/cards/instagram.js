// Instagram: the page serves a full set of OpenGraph tags, but Discord shows
// nothing for the link — a bare URL posted to a real channel came back with
// zero embeds, verified. So the card is built from the tags ourselves.
//
// Same shape as Threads: one page fetch with a browser user agent, then
// og:title / og:description / og:image / og:url. The reel poster on
// scontent.cdninstagram.com is fetchable by Discord, so the image is
// referenced, never uploaded.

import {
  authorBlock,
  getHtml,
  INSTAGRAM_PINK,
  metaContent,
  toField,
} from './shared.js';

/** "1M likes, 11K comments - abdulelsayed on August 31, 2026: …" */
const ENGAGEMENT = /^([\d.,]+[KMB]?)\s+likes?,\s+([\d.,]+[KMB]?)\s+comments?/i;

export async function buildInstagramCard({ href }, options) {
  // A reel or a TV post is a video, and Discord only plays one it unfurls
  // itself — an embed of ours in the same message suppresses that unfurl
  // entirely (verified). So a video post gets no card: the clean link plus the
  // fixer link, and Discord draws the player with the caption and counts.
  const video = fixerLink(href);
  if (video) return { embeds: [], files: [], extraLines: [video] };

  const page = await getHtml(href, options);
  if (!page) return null;

  const title = metaContent(page.html, 'og:title');
  if (!title) return null;

  // og:title is `<Name> on Instagram: "<caption>"`.
  const named = /^(.*?)\s+on Instagram:\s*"?(.*?)"?$/s.exec(title);
  const name = named ? named[1] : '';
  const caption = named ? named[2] : title;

  // The canonical URL carries the handle: instagram.com/<handle>/reel/<id>/.
  const canonical = metaContent(page.html, 'og:url') ?? href;
  const handle = new URL(canonical).pathname.split('/')[1] ?? '';

  const embed = {
    url: canonical,
    color: INSTAGRAM_PINK,
    footer: { text: 'Instagram' },
  };

  if (name || handle) {
    embed.author = authorBlock(
      [name, handle && `(@${handle})`].filter(Boolean).join(' '),
      'Instagram',
      { url: handle ? `https://www.instagram.com/${handle}/` : canonical },
    );
  }

  if (caption.trim()) embed.description = toField(caption.trim(), 4096);

  const image = metaContent(page.html, 'og:image');
  if (image) embed.image = { url: image };

  // The count prefix is the only structured data on the page. It is dropped
  // from the caption above and shown as fields instead.
  const description = metaContent(page.html, 'og:description');
  const engagement = description ? ENGAGEMENT.exec(description) : null;
  if (engagement) {
    embed.fields = [
      { name: 'Likes', value: engagement[1], inline: true },
      { name: 'Comments', value: engagement[2], inline: true },
    ];
  }

  return { embeds: [embed], files: [] };
}

/**
 * The fixer link for a video post, or null.
 *
 * Derived from the incoming URL, not from `og:url`: the canonical path carries
 * the handle (`/abdulelsayed/reel/<id>/`) while vxinstagram takes
 * `/reel/<id>/`.
 */
function fixerLink(href) {
  const url = new URL(href);
  if (!/(?:^|\/)(?:reel|reels|tv)\//.test(url.pathname)) return null;
  return `https://vxinstagram.com${url.pathname}`;
}
