import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { buildNhentaiCard } from '../../src/cards/nhentai.js';
import { fakeFetch, fixture, imageResponse, IMAGE_BYTES } from '../../test-support/harness.js';

const GALLERY = fixture('nhentai-gallery.json');
const URL = 'https://nhentai.net/g/693549/';

const fetchGallery = () => fakeFetch([['https://nhentai.net/api/v2/galleries/693549', GALLERY]]);

test('nhentai card carries the title, cover, counts and tag groups', async () => {
  const { impl } = fetchGallery();
  const [card] = await buildCards(URL, { fetchImpl: impl, nsfw: true });

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  const embed = card.embeds[0];
  assert.equal(embed.title, GALLERY.title.pretty);
  assert.equal(embed.description, undefined, 'the bracketed English title adds nothing');
  assert.equal(embed.url, URL);
  assert.equal(embed.image.url, `https://t.nhentai.net/${GALLERY.cover.path}`);
  assert.equal(embed.footer.text, 'nhentai');
  assert.equal(embed.timestamp, new Date(GALLERY.upload_date * 1000).toISOString());
  assert.equal(embed.author.name, 'takashima shoa (high land)');
  assert.equal(embed.author.url, 'https://nhentai.net');

  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Pages, '33');
  assert.equal(fields.Favorites, '1,229');
  assert.equal(fields.Language, 'translated, english');
  assert.equal(fields.Scanlator, undefined, 'empty scanlator is not a field');
  assert.equal(fields.Artists, 'takashima shoa');
  assert.equal(fields.Groups, 'high land');
  assert.equal(fields.Parodies, 'blue archive');
  assert.equal(fields.Characters, 'sensei, miyo sakurai');
  assert.equal(fields.Tags.split(', ').length, 12, 'the tag list is capped');
});

test('nhentai card is refused when neither the channel nor the spoiler mode allows it', async () => {
  const { impl, calls } = fetchGallery();
  const cards = await buildCards(URL, { fetchImpl: impl });

  assert.deepEqual(cards, []);
  assert.equal(calls.length, 0, 'no request is made when no presentation is allowed');
});

test('spoiler mode hides the cover in an attachment and drops the explicit tags', async () => {
  const { impl, calls } = fakeFetch([
    ['https://nhentai.net/api/v2/galleries/693549', GALLERY],
    ['https://t.nhentai.net/', imageResponse()],
  ]);
  const [card] = await buildCards(URL, { fetchImpl: impl, spoiler: true });

  assert.ok(card);
  const embed = card.embeds[0];
  assert.equal(embed.image, undefined, 'an embed image cannot be spoilered');
  assert.equal(embed.title, GALLERY.title.pretty);
  assert.equal(embed.author.name, 'takashima shoa (high land)');
  assert.equal(embed.footer.text, 'nhentai · spoiler');

  const names = embed.fields.map((field) => field.name);
  assert.deepEqual(names, ['Pages', 'Favorites', 'Language']);
  assert.ok(!names.includes('Tags'), 'the explicit tag list is the part that is dropped');

  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].name, 'SPOILER_cover.webp');
  assert.deepEqual(card.files[0].attachment, IMAGE_BYTES);
  assert.equal(calls.at(-1).url, `https://t.nhentai.net/${GALLERY.cover.path}`);
});

test('spoiler mode still shows the full card in an age-restricted channel', async () => {
  const { impl } = fakeFetch([['https://nhentai.net/api/v2/galleries/693549', GALLERY]]);
  const [card] = await buildCards(URL, { fetchImpl: impl, nsfw: true, spoiler: true });

  assert.ok(card.embeds[0].image, 'the age-restricted channel gets the picture');
  assert.ok(card.embeds[0].fields.some((field) => field.name === 'Tags'));
  assert.deepEqual(card.files, []);
});

test('spoiler mode gives up the cover when the message has no file budget', async () => {
  const { impl } = fakeFetch([['https://nhentai.net/api/v2/galleries/693549', GALLERY]]);
  const card = await buildNhentaiCard(
    { match: ['/g/693549/', '693549'], href: URL },
    { fetchImpl: impl, spoiler: true, budget: { files: 0, bytes: 8_000_000 } },
  );

  assert.ok(card, 'the metadata card survives a spent budget');
  assert.deepEqual(card.files, [], 'but no attachment is fetched or attached');
});

test('nhentai card is skipped when the gallery does not exist', async () => {
  const { impl } = fakeFetch([
    ['https://nhentai.net/api/v2/galleries/693549', new Response('{"error":"Gallery not found"}', { status: 404 })],
  ]);
  const cards = await buildCards(URL, { fetchImpl: impl, nsfw: true });
  assert.deepEqual(cards, []);
});

test('nhentai card matches a gallery path with or without a slug', async () => {
  for (const url of [
    'https://nhentai.net/g/693549',
    'https://nhentai.net/g/693549/',
    'https://nhentai.net/g/693549/houkago-kyouhansha/',
  ]) {
    const { impl } = fetchGallery();
    const [card] = await buildCards(url, { fetchImpl: impl, nsfw: true });
    assert.ok(card, url);
  }
});
