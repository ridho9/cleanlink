// Threads: the page serves the post text in `og:description`, but only to a
// browser user agent — Discordbot gets a shell with no description at all.

import {
  authorBlock,
  decodeEntities,
  getHtml,
  metaContent,
  THREADS_BLACK,
  toField,
} from './shared.js';

async function buildThreadsCard({ href }, options) {
  const page = await getHtml(href, options);
  if (!page) return null;

  const description = metaContent(page.html, 'og:description');
  // Without the text there is nothing this card adds over Discord's own
  // preview, which already shows the author and the image.
  if (!description) return null;

  const title = metaContent(page.html, 'og:title') ?? 'Threads';
  const author = title.replace(/\s+on Threads$/i, '').trim();
  const embed = {
    url: metaContent(page.html, 'og:url') ?? href,
    color: THREADS_BLACK,
    author: authorBlock(author, 'Threads', { url: href }),
    description: toField(description, 4096),
    footer: { text: 'Threads' },
  };

  const image = metaContent(page.html, 'og:image');
  // A text-only post still has an og:image: the author's avatar, served from
  // Instagram's profile-photo bucket (type `t51.2885-19`). That belongs in the
  // corner, not across the card. Post media uses other type ids.
  if (image) {
    if (/\/t51\.2885-19\//.test(image)) embed.thumbnail = { url: image };
    else embed.image = { url: image };
  }

  return { embeds: [embed], files: [] };
}

export { buildThreadsCard };
