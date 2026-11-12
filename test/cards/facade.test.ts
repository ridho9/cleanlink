import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards, hasCardFor } from '../../src/cards/index.ts';
import { fakeFetch, fixture, imageResponse } from '../../test-support/harness.ts';

const X_TEXT = fixture('x-text.json');
const PIXIV = fixture('pixiv-illust.json');
const PIXIV_PAGES = fixture('pixiv-pages.json');

test('buildCards stops at the image budget', async () => {
  const heavy = {
    ...PIXIV,
    body: { ...PIXIV.body, pageCount: 9 },
  };
  const pages = {
    body: Array.from({ length: 9 }, (_, index) => ({
      urls: { regular: `https://i.pximg.net/img-master/img/x_p${index}_master1200.jpg` },
    })),
  };
  // 6 MB each: the second page would pass the limit, so only the first survives.
  // A factory, because the pages are fetched in parallel.
  const big = () => new Response(Buffer.alloc(6_000_000), { status: 200 });
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', pages],
    ['https://www.pixiv.net/ajax/illust/151616953', heavy],
    ['https://i.pximg.net/', big],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });
  assert.equal(card.files.length, 1);
});

test('a shorthand inside spoiler markup is left alone', async () => {
  const { impl, calls } = fakeFetch([]);

  // `||nh/693549||` hides the reference on purpose, exactly like a spoiled
  // link. Carding it would post the expanded gallery in the clear.
  assert.equal(hasCardFor('||nh/693549||'), false);
  assert.equal(hasCardFor('nh/693549'), true);
  assert.deepEqual(await buildCards('||nh/693549||', { fetchImpl: impl }), []);
  assert.equal(calls.length, 0);
});

test('a card that would pass the embed text budget is dropped whole', async () => {
  const long = {
    ...X_TEXT,
    tweet: { ...X_TEXT.tweet, text: 'x'.repeat(4000) },
  };
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', long]]);

  // Two cards of about 4000 characters each pass the embed count (10) and the
  // byte budget, but not Discord's 6000 characters of embed text; the second
  // is dropped, and the reply still goes out with the first.
  const cards = await buildCards('https://x.com/a/status/1 https://x.com/b/status/2', { fetchImpl: impl });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].from, 'https://x.com/a/status/1');
});

test('buildCards only cards the listed sites, once, and in order', async () => {
  const { impl, calls } = fakeFetch([
    ['https://api.fxtwitter.com/', X_TEXT],
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const text = [
    'https://example.com/not-ours',
    'https://x.com/jack/status/20',
    'https://x.com/jack/status/20',
    'https://www.pixiv.net/artworks/151616953',
  ].join(' ');

  const cards = await buildCards(text, { fetchImpl: impl });
  assert.deepEqual(cards.map((card) => card.from), [
    'https://x.com/jack/status/20',
    'https://www.pixiv.net/artworks/151616953',
  ]);
  assert.equal(calls.filter((call) => call.url.startsWith('https://api.fxtwitter.com/')).length, 1);
});

test('buildCards cards every handled link, not just the first', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);

  const cards = await buildCards(
    'https://x.com/a/status/20 and https://x.com/b/status/21 https://twitter.com/c/status/22',
    { fetchImpl: impl },
  );

  // Every route serves the same fixture, so the ids look alike; what matters
  // is that all three inputs were carded rather than only the first.
  assert.deepEqual(cards.map((card) => card.from), [
    'https://x.com/a/status/20',
    'https://x.com/b/status/21',
    'https://twitter.com/c/status/22',
  ]);
});

test('buildCards keeps the message inside ten embeds', async () => {
  // Three five-page works: two fit (5 + 5), the third does not fit the budget.
  const page = {
    body: Array.from({ length: 5 }, (_, index) => ({
      urls: { regular: `https://i.pximg.net/img-master/img/x_p${index}_master1200.jpg` },
    })),
  };
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/1/pages', page],
    ['https://www.pixiv.net/ajax/illust/2/pages', page],
    ['https://www.pixiv.net/ajax/illust/3/pages', page],
    ['https://www.pixiv.net/ajax/illust/', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const cards = await buildCards(
    'https://www.pixiv.net/artworks/1 https://www.pixiv.net/artworks/2 https://www.pixiv.net/artworks/3',
    { fetchImpl: impl },
  );

  assert.equal(cards.length, 2, 'the third work had no embed budget left');
  assert.equal(cards.flatMap((card) => card.embeds).length, 10);
  assert.equal(cards.flatMap((card) => card.files).length, 10);
});

test('buildCards shares the attachment byte budget across cards', async () => {
  const page = {
    body: [{ urls: { regular: 'https://i.pximg.net/img-master/img/x_p0_master1200.jpg' } }],
  };
  // 6 MB each: the first card fits, the second has only 3.5 MB left.
  const big = () => new Response(Buffer.alloc(6_000_000), { status: 200 });
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/1/pages', page],
    ['https://www.pixiv.net/ajax/illust/2/pages', page],
    ['https://www.pixiv.net/ajax/illust/', PIXIV],
    ['https://i.pximg.net/', big],
  ]);

  const cards = await buildCards(
    'https://www.pixiv.net/artworks/1 https://www.pixiv.net/artworks/2',
    { fetchImpl: impl },
  );

  assert.equal(cards.length, 1, 'the second card had no room for its image');
  assert.equal(cards[0].files.length, 1);
});
