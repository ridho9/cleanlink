import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixtureText } from '../../test-support/harness.js';

const REEL_HTML = fixtureText('instagram-reel.html');
const CAROUSEL_PAGE = fixtureText('instagram-carousel-page.html');
const CAROUSEL_FIXER = fixtureText('instagram-carousel.html');
const URL = 'https://www.instagram.com/reel/DcuMLVagTPh/';

test('an Instagram photo post is carded from its OpenGraph tags', async () => {
  const { impl, calls } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(calls[0].headers['user-agent'], 'Mozilla/5.0');

  const embed = card.embeds[0];
  assert.equal(embed.author.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.equal(embed.author.url, 'https://www.instagram.com/abdulelsayed/');
  assert.equal(embed.url, 'https://www.instagram.com/abdulelsayed/reel/DcuMLVagTPh/');
  assert.ok(embed.description.startsWith('Heard there’s a reunion happening tonight?'));
  assert.ok(embed.image.url.startsWith('https://scontent.cdninstagram.com/'));
  assert.equal(embed.footer.text, 'Instagram');

  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.deepEqual(fields, { Likes: '1M', Comments: '11K' });
  assert.deepEqual(card.extraLines ?? [], []);
});

test('a carousel yields one embed per image, all from stable fixer URLs', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/', CAROUSEL_PAGE],
    ['https://vxinstagram.com/', CAROUSEL_FIXER],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DfUUHeAmjwC/', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds.length, 3);
  assert.deepEqual(
    card.embeds.map((embed) => embed.image.url),
    [
      'https://vxinstagram.com/offload/DfUUHeAmjwC/0',
      'https://vxinstagram.com/offload/DfUUHeAmjwC/1',
      'https://vxinstagram.com/offload/DfUUHeAmjwC/2',
    ],
    'signed CDN URLs expire; the fixer paths do not',
  );
  assert.deepEqual(
    card.embeds.map((embed) => embed.footer.text),
    ['Instagram · 1/3', 'Instagram · 2/3', 'Instagram · 3/3'],
  );

  // The account comes from the canonical URL, because /p/<id>/ has no handle.
  assert.equal(card.embeds[0].author.name, 'Event Organizer Padang (@kaluma.organizer)');
  assert.equal(card.embeds[0].author.url, 'https://www.instagram.com/kaluma.organizer/');
  assert.ok(card.embeds[0].description.startsWith('Let the reveals begin!'));
  // Counts come from Instagram's description prefix, not the fixer page.
  assert.deepEqual(
    card.embeds[0].fields.map((field) => `${field.name}=${field.value}`),
    ['Likes=12', 'Comments=0'],
  );
  assert.equal(card.embeds[1].author, undefined, 'the rest are images only');
});

test('a single-image post falls back to the page image and has no page counter', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });

  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].footer.text, 'Instagram');
  assert.ok(card.embeds[0].image.url.startsWith('https://scontent.cdninstagram.com/'));
});

test('a reel keeps its card and puts the video in a masked follow-up', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const direct = 'https://instagram.fpku7-1.fna.fbcdn.net/o1/v/t2/reel.mp4';

  const [card] = await buildCards(URL, { fetchImpl: impl, videoUrl: async () => direct });

  assert.ok(card);
  assert.equal(card.embeds.length, 1, 'the author and caption stay');
  assert.equal(card.embeds[0].author.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.ok(card.embeds[0].description.startsWith('Heard there’s a reunion'));
  assert.ok(card.embeds[0].image, 'and the poster frame');
  assert.deepEqual(card.files, [], 'nothing is downloaded');
  assert.deepEqual(card.extraLines, undefined, 'the carded link is bracketed, not labelled');
  assert.deepEqual(card.followUps, [`[reel](${direct})`]);
});

test('a reel with no resolvable URL keeps the card alone', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards(URL, { fetchImpl: impl, videoUrl: async () => null });

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  assert.equal(card.followUps, undefined);
});

test('a photo post with no OpenGraph title gets no card', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', '<html><head></head></html>']]);
  const cards = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});

test('Instagram card matches every permalink shape', async () => {
  for (const url of [
    'https://www.instagram.com/p/AbCdEf12345/',
    'https://www.instagram.com/reel/DcuMLVagTPh/',
    'https://www.instagram.com/tv/AbCdEf12345/',
  ]) {
    const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
    const [card] = await buildCards(url, { fetchImpl: impl });
    assert.ok(card, url);
  }
});
