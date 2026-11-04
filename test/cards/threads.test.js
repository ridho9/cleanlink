import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixtureText } from '../../test-support/harness.js';

const THREADS_HTML = fixtureText('threads-post.html');

test('Threads card asks for a browser user agent and keeps the post text', async () => {
  const { impl, calls } = fakeFetch([['https://www.threads.com/', THREADS_HTML]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card);
  assert.equal(calls[0].headers['user-agent'], 'Mozilla/5.0', 'Discordbot would get no text');
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'Yoan Dipo Asani (@phodhipo)');
  assert.ok(card.embeds[0].description.startsWith('Bukan sombong ya.'));
  assert.ok(!card.embeds[0].description.includes('&'));
  assert.equal(card.embeds[0].footer.text, 'Threads');
  // A text-only post's og:image is the avatar, so it goes in the corner.
  assert.ok(card.embeds[0].thumbnail.url.includes('scontent.cdninstagram.com'));
  assert.equal(card.embeds[0].image, undefined);
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

  assert.ok(card.embeds[0].image);
  assert.equal(card.embeds[0].thumbnail, undefined);
});

test('Threads card is skipped when the page has no description', async () => {
  const { impl } = fakeFetch([['https://www.threads.com/', '<html><head></head></html>']]);
  const cards = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});
