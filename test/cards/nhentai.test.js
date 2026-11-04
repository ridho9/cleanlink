import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixture } from '../../test-support/harness.js';

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

test('nhentai card is refused unless the channel is age-restricted', async () => {
  const { impl, calls } = fetchGallery();
  const cards = await buildCards(URL, { fetchImpl: impl });

  assert.deepEqual(cards, []);
  assert.equal(calls.length, 0, 'no request is made for a channel that cannot show it');
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
