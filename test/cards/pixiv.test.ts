import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { fakeFetch, fixture, IMAGE_BYTES, imageResponse } from '../../test-support/harness.ts';

const PIXIV = fixture('pixiv-illust.json');
const PIXIV_PAGES = fixture('pixiv-pages.json');

test('Pixiv card re-hosts the pages, because Discord cannot fetch pximg', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds[0].url, 'https://www.pixiv.net/artworks/151616953');
  assert.equal(card.embeds[0].author!.name, PIXIV.body.userName);
  assert.equal(card.embeds[0].author!.url, `https://www.pixiv.net/users/${PIXIV.body.userId}`);
  assert.equal(card.embeds[0].title, PIXIV.body.illustTitle);
  assert.equal(card.files.length, PIXIV_PAGES.body.length);
  assert.deepEqual(card.files.map((file) => file.name), ['p0.jpg', 'p1.jpg']);
  assert.equal(card.embeds[0].image!.url, 'attachment://p0.jpg');
  assert.match(card.embeds[0].footer!.text, /^Pixiv · 2 page/);
  // One embed per page, all at full size. Both files are claimed, so no loose
  // attachment appears above the card.
  assert.equal(card.embeds.length, 2);
  assert.equal(card.embeds[1].image!.url, 'attachment://p1.jpg');
  assert.equal(card.embeds[1].footer!.text, 'Pixiv · page 2/2');
  assert.equal(card.embeds[0].thumbnail, undefined);
  assert.ok(card.files.every((file) => Buffer.compare(file.attachment, IMAGE_BYTES) === 0));

  // Every pixiv request needs the Referer, including the images.
  for (const call of calls) {
    assert.equal(call.headers.referer, 'https://www.pixiv.net/', call.url);
  }
});

test('Pixiv card spoils restricted works and caps the page count', async () => {
  const many = {
    ...PIXIV,
    body: { ...PIXIV.body, xRestrict: 1, pageCount: 9 },
  };
  const pages = {
    body: Array.from({ length: 9 }, (_, index) => ({
      urls: { regular: `https://i.pximg.net/img-master/img/x_p${index}_master1200.jpg` },
    })),
  };
  const { impl, calls } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', pages],
    ['https://www.pixiv.net/ajax/illust/151616953', many],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/en/artworks/151616953', { fetchImpl: impl });

  assert.equal(card.files.length, 5);
  assert.deepEqual(card.files.map((file) => file.name), [
    'SPOILER_p0.jpg',
    'SPOILER_p1.jpg',
    'SPOILER_p2.jpg',
    'SPOILER_p3.jpg',
    'SPOILER_p4.jpg',
  ]);
  assert.equal(card.embeds[0].image!.url, 'attachment://SPOILER_p0.jpg');
  assert.equal(card.embeds[0].footer!.text, 'Pixiv · restricted');
  assert.equal(card.embeds.length, 5);
  assert.equal(card.files.length, 5);
  assert.equal(card.embeds[4].image!.url, 'attachment://SPOILER_p4.jpg');
  assert.equal(card.embeds[4].footer!.text, 'Pixiv · page 5/5');
  assert.equal(calls.filter((call) => call.url.startsWith('https://i.pximg.net/')).length, 5);
});

test('Pixiv card is skipped when no image can be fetched', async () => {
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    // Images 403, exactly as they do for Discord's crawler.
    ['https://i.pximg.net/', new Response('forbidden', { status: 403 })],
  ]);

  const cards = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});
