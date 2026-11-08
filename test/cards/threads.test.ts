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

test('an avatar from any profile-photo bucket stays in the corner', async () => {
  const html = THREADS_HTML.replace(/\/t51\.2885-19\//, '/t51.82787-19/');
  const { impl } = fakeFetch([['https://www.threads.com/', html]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card!.embeds[0]!.thumbnail);
  assert.equal(card!.embeds[0]!.image, undefined);
});

test('a text reply quotes its parent and shows the parent\'s image', async () => {
  // Shaped as Threads serves it: the reply in one script, and in another a
  // record with the same pk whose `containing_thread` ends with the parent.
  const reply = {
    pk: '402',
    code: 'ReplyCode01',
    user: { username: 'troy', full_name: 'Troy', profile_pic_url: 'https://cdn.example/troy.jpg' },
    caption: { text: 'went blue before Texas did.' },
    taken_at: 1793913094,
    like_count: 3205,
    image_versions2: { candidates: [] },
    text_post_app_info: { is_reply: true, reply_to_author: { username: 'doc' }, direct_reply_count: 32, repost_count: 29, quote_count: 2 },
  };
  const parent = {
    pk: '401',
    code: 'ParentCode1',
    user: { username: 'doc', full_name: 'Doc Bradley' },
    caption: { text: 'To be fair,\nit didn\'t happen.' },
    image_versions2: { candidates: [{ url: 'https://cdn.example/parent.jpg' }] },
  };
  const thread = { data: { media: { pk: '402', text_post_app_info: { containing_thread: { posts: { edges: [{ node: parent }] } } } } } };
  const scripts = [{ data: { media: reply } }, thread]
    .map((data) => `<script type="application/json" data-sjs>${JSON.stringify(data)}</script>`)
    .join('');
  const { impl } = fakeFetch([['https://www.threads.com/', `<html><body>${scripts}</body></html>`]]);
  const [card] = await buildCards('https://www.threads.com/@troy/post/ReplyCode01', { fetchImpl: impl });

  const embed = card!.embeds[0]!;
  assert.equal(embed.author!.name, 'Troy (@troy)');
  assert.equal(embed.author!.icon_url, 'https://cdn.example/troy.jpg');
  assert.equal(
    embed.description,
    'went blue before Texas did.\n\n> **Replying to Doc Bradley (@doc)**\n> To be fair,\n> it didn\'t happen.\n\n💬 32 · 🔁 29 · ❝ 2 · ❤️ 3,205',
  );
  assert.equal(embed.image!.url, 'https://cdn.example/parent.jpg');
  assert.equal(embed.fields, undefined, 'no field per number');
  assert.equal(embed.timestamp, new Date(1793913094 * 1000).toISOString());
});

/**
 * The page as Threads serves it: one JSON script holding the post and its
 * replies, each with its own carousel (or none).
 */
function withPosts(posts: { code: string; urls?: string[] }[]) {
  const items = posts.map(({ code, urls }) => ({
    post: {
      code,
      user: { username: 'phodhipo', full_name: 'Yoan Dipo Asani' },
      caption: { text: 'Bukan sombong ya.' },
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

test('Threads card says so when the page carries no post', async () => {
  // What Threads serves for a deleted post, or one limited to some audiences.
  const { impl } = fakeFetch([['https://www.threads.com/', '<html><head><title>Threads</title></head></html>']]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  const embed = card!.embeds[0]!;
  assert.equal(embed.title, 'Post not available');
  assert.equal(embed.url, 'https://www.threads.com/@phodhipo/post/DfPOscPD6UR');
  assert.equal(embed.description, 'Deleted, or limited to some audiences.');
  assert.equal(embed.footer!.text, 'Threads');
});

test('Threads card stays silent when the fetch itself fails', async () => {
  const { impl } = fakeFetch([]);
  assert.deepEqual(await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', { fetchImpl: impl }), []);
});
