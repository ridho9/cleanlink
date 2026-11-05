import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { fakeFetch, fixtureText } from '../../test-support/harness.ts';

const THREADS_HTML = fixtureText('threads-post.html');

test('Threads card asks for a browser user agent and keeps the post text', async () => {
  const { impl, calls } = fakeFetch([['https://www.threads.com/', THREADS_HTML]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card);
  assert.equal(calls[0]!.headers['user-agent'], 'Mozilla/5.0', 'Discordbot would get no text');
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0]!.author!.name, 'Yoan Dipo Asani (@phodhipo)');
  assert.ok(card.embeds[0]!.description!.startsWith('Bukan sombong ya.'));
  assert.ok(!card.embeds[0]!.description!.includes('&'));
  assert.equal(card.embeds[0]!.footer!.text, 'Threads');
  // A text-only post's og:image is the avatar, so it goes in the corner.
  assert.ok(card.embeds[0]!.thumbnail!.url.includes('scontent.cdninstagram.com'));
  assert.equal(card.embeds[0]!.image, undefined);
});

test('Threads card shows post media large, not the avatar', async () => {
  const withMedia = THREADS_HTML.replace(
    /\/t51\.2885-19\//,
    '/t39.92108-6/',
  );
  const { impl } = fakeFetch([['https://www.threads.com/', withMedia]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card!.embeds[0]!.image);
  assert.equal(card!.embeds[0]!.thumbnail, undefined);
});

/**
 * The page as Threads serves it: one JSON script holding the post and its
 * replies, each with its own carousel (or none).
 */
function withPosts(posts: { code: string; urls?: string[] }[]) {
  const items = posts.map(({ code, urls }) => ({
    post: {
      code,
      ...(urls ? { carousel_media: urls.map((url) => ({ image_versions2: { candidates: [{ url }, { url: `${url}?small` }] } })) } : {}),
    },
  }));
  const script = `<script type="application/json" data-sjs>${JSON.stringify({ require: [[{ thread_items: items }]] })}</script>`;
  return THREADS_HTML.replace('</body>', `${script}</body>`);
}

test('Threads carousel shows every image as one gallery, largest rendition', async () => {
  const urls = ['https://cdn.example/1.webp', 'https://cdn.example/2.webp', 'https://cdn.example/3.webp'];
  const { impl } = fakeFetch([['https://www.threads.com/', withPosts([{ code: 'DfPOscPD6UR', urls }])]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.deepEqual(card!.embeds.map((embed) => embed.image?.url), urls);
  assert.ok(card!.embeds.every((embed) => embed.url === card!.embeds[0]!.url), 'one URL makes one gallery');
  assert.deepEqual(card!.embeds.map((embed) => embed.footer?.text), ['Threads · 1/3', 'Threads · 2/3', 'Threads · 3/3']);
  assert.equal(card!.embeds[0]!.thumbnail, undefined, 'the avatar is not shown next to the gallery');
});

test('a reply\'s carousel on the same page is not used for the post', async () => {
  const html = withPosts([
    { code: 'ReplyPost01', urls: ['https://cdn.example/a.webp', 'https://cdn.example/b.webp'] },
    { code: 'DfPOscPD6UR' },
  ]);
  const { impl } = fakeFetch([['https://www.threads.com/', html]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.image, undefined);
});

test('Threads card is skipped when the page has no description', async () => {
  const { impl } = fakeFetch([['https://www.threads.com/', '<html><head></head></html>']]);
  const cards = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});
