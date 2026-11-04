// Facebook: the post page is a login wall, but the public embed iframe at
// /plugins/post.php is not. It answers "unavailable" for posts that forbid
// embedding, which is simply no card.

import {
  authorBlock,
  decodeEntities,
  getHtml,
  imageEmbeds,
  toField,
  FACEBOOK_BLUE,
} from './shared.js';

/** Inner HTML of the div that starts at `from`, honouring nesting. */
function innerDiv(html, from) {
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
function htmlToText(fragment) {
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
function feedCard(html, match, href) {
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
  const embed = { url: href, color: FACEBOOK_BLUE, footer };
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

/** Post images: everything on scontent that is not an avatar. */
function mediaImages(html) {
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

async function buildFacebookCard({ match, href }, options) {
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

      const refused = /tidak tersedia|isn't available|is not available/i.test(page.html);
      // Say why, as far as the answer allows: an anonymous request cannot tell
      // a deleted post from a private one or an age-restricted one — Facebook
      // returns the same "no longer available" page for all three, and the
      // words "age" and "login" appear in every response's scripts.
      console.log(
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

    const images = mediaImages(page.html);

    const footer = { text: 'Facebook' };
    const embed = {
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

    return { embeds, files: [] };
  }

  return null;
}

export { buildFacebookCard };
