import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards, hasCardFor } from '../../src/cards/index.js';
import { buildNhentaiCard } from '../../src/cards/nhentai.js';
import { fakeFetch, fixture, IMAGE_BYTES, imageResponse } from '../../test-support/harness.js';

const GALLERY = fixture('nhentai-gallery.json');
const URL = 'https://nhentai.net/g/693549/';

const fetchGallery = () =>
  fakeFetch([
    ['https://nhentai.net/api/v2/galleries/693549', GALLERY],
    ['https://t.nhentai.net/', imageResponse()],
  ]);

test('nhentai card shows the title, the author and a spoilered cover', async () => {
  const { impl } = fetchGallery();
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  const embed = card.embeds[0];
  assert.equal(embed.title, GALLERY.title.pretty);
  assert.equal(embed.author.name, 'takashima shoa (high land)');
  assert.equal(embed.author.url, 'https://nhentai.net');
  assert.equal(embed.url, URL);
  assert.equal(embed.footer.text, 'nhentai');
  assert.equal(embed.timestamp, new Date(GALLERY.upload_date * 1000).toISOString());

  // Nothing explicit in the card itself.
  assert.equal(embed.image, undefined, 'Discord cannot spoiler an embed image');
  assert.equal(embed.fields, undefined, 'counts and tags are not part of this card');
  assert.equal(embed.description, undefined);

  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].name, 'SPOILER_cover.webp');
  assert.deepEqual(card.files[0].attachment, IMAGE_BYTES);
});

test('nhentai card downloads the cover from the URL the API reports', async () => {
  const { impl, calls } = fetchGallery();
  await buildCards(URL, { fetchImpl: impl });

  assert.equal(calls.at(-1).url, `https://t.nhentai.net/${GALLERY.cover.path}`);
});

test('nhentai card is skipped when the gallery does not exist', async () => {
  const { impl } = fakeFetch([
    [
      'https://nhentai.net/api/v2/galleries/693549',
      new Response('{"error":"Gallery not found"}', { status: 404 }),
    ],
  ]);
  const cards = await buildCards(URL, { fetchImpl: impl });
  assert.deepEqual(cards, []);
});

test('nhentai card still appears without the cover when the file budget is spent', async () => {
  const { impl } = fakeFetch([['https://nhentai.net/api/v2/galleries/693549', GALLERY]]);
  const card = await buildNhentaiCard(
    { match: ['/g/693549/', '693549'], href: URL },
    { fetchImpl: impl, budget: { files: 0, bytes: 8_000_000 } },
  );

  assert.ok(card);
  assert.deepEqual(card.files, []);
  assert.ok(card.embeds[0].title);
});

test('nhentai card matches a gallery path with or without a slug', async () => {
  for (const url of [
    'https://nhentai.net/g/693549',
    'https://nhentai.net/g/693549/',
    'https://nhentai.net/g/693549/houkago-kyouhansha/',
  ]) {
    const { impl } = fetchGallery();
    const [card] = await buildCards(url, { fetchImpl: impl });
    assert.ok(card, url);
  }
});

test('nh/<id> shorthand expands to the gallery link', async () => {
  const { impl } = fetchGallery();
  const [card] = await buildCards('look nh/693549', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.from, 'nh/693549');
  assert.equal(card.url, 'https://nhentai.net/g/693549/');
  assert.equal(card.embeds[0].title, GALLERY.title.pretty);
});

test('shorthand and the full link produce one card, not two', async () => {
  const { impl } = fetchGallery();
  const cards = await buildCards('nh/693549 https://nhentai.net/g/693549/', { fetchImpl: impl });
  assert.equal(cards.length, 1);
});

test('hasCardFor sees the shorthand and ignores text that is not one', () => {
  assert.equal(hasCardFor('nh/693549'), true);
  assert.equal(hasCardFor('https://nhentai.net/g/693549/'), true);
  assert.equal(hasCardFor('nh/abc'), false);
  assert.equal(hasCardFor('nh/1234567890123'), false, 'ids stop at nine digits');
  assert.equal(hasCardFor('nothing to see'), false);
  assert.equal(hasCardFor(''), false);
});
