import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixture, fixtureText } from '../../test-support/harness.js';

const REEL_HTML = fixtureText('instagram-reel.html');
const CAROUSEL_PAGE = fixtureText('instagram-carousel-page.html');
const EMBED_CAROUSEL = fixtureText('instagram-embed-carousel.html');
const EMBED_VIDEO = fixtureText('instagram-embed-video.html');
const OEMBED = fixture('instagram-oembed.json');
const SINGLE_PAGE = fixtureText('instagram-single.html');

// The reel's frame, as each page reports it.
const EMBED_FRAME = /"display_url":"([^"]+)"/.exec(EMBED_VIDEO.replace(/\\/g, ''))[1];
const OG_IMAGE = /property="og:image" content="([^"]+)"/.exec(REEL_HTML)[1].replace(/&amp;/g, '&');
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

test('a carousel yields one embed per image, from Instagram\'s own payload', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.instagram.com/p/DfUUHeAmjwC/embed/captioned/', EMBED_CAROUSEL],
    ['https://www.instagram.com/', CAROUSEL_PAGE],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DfUUHeAmjwC/', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds.length, 4);
  assert.ok(
    card.embeds.every((embed) => embed.image.url.startsWith('https://instagram.')),
    'every image is a signed Instagram CDN URL, not a third-party proxy',
  );
  assert.equal(new Set(card.embeds.map((embed) => embed.image.url)).size, 4, 'four distinct images');
  assert.deepEqual(
    card.embeds.map((embed) => embed.footer.text),
    ['Instagram · 1/4', 'Instagram · 2/4', 'Instagram · 3/4', 'Instagram · 4/4'],
  );
  assert.ok(calls.some((call) => call.url.includes('/embed/captioned/')));
  assert.ok(!calls.some((call) => call.url.includes('vxinstagram')), 'no third party is asked');

  assert.equal(card.embeds[0].author.name, 'Event Organizer Padang (@kaluma.organizer)');
  assert.equal(card.embeds[0].author.url, 'https://www.instagram.com/kaluma.organizer/');
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

test('oEmbed supplies the full caption, the handle and an uncropped thumbnail', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/api/v1/oembed/', OEMBED],
    ['https://www.instagram.com/', SINGLE_PAGE],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DeeC3rrBqAK/', { fetchImpl: impl });

  assert.ok(card);
  const embed = card.embeds[0];
  // The handle comes from oEmbed, so no path guessing is needed.
  assert.match(embed.author.name, /\(@chinese\\_mandarin\\_zest\)$/, 'the handle is escaped for markdown');
  assert.match(embed.author.name, /^Mandarin Zest/, 'the display name comes from the page');
  assert.equal(embed.author.url, 'https://www.instagram.com/chinese_mandarin_zest/');
  // The OpenGraph caption is clipped; oEmbed's is not.
  assert.ok(embed.description.startsWith('✡️ How do you talk about Judaism in Chinese?'));
  // The thumbnail keeps its aspect ratio instead of a square crop.
  assert.equal(embed.image.url, OEMBED.thumbnail_url);
  assert.ok(!embed.image.url.includes('s640x640'), 'not the square crop');
});

test('a reel is carded like a photo post, with a clean frame and no link', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/p/DcuMLVagTPh/embed/captioned/', EMBED_VIDEO],
    ['https://www.instagram.com/', REEL_HTML],
  ]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.ok(card.embeds[0].description.startsWith('Heard there’s a reunion'));

  // The frame comes from the embed payload, not `og:image` — Instagram bakes a
  // play button into the OpenGraph thumbnail.
  assert.equal(card.embeds[0].image.url, EMBED_FRAME);
  assert.notEqual(card.embeds[0].image.url, OG_IMAGE);
  assert.equal(card.extraLines, undefined, 'no video link is offered');
  assert.deepEqual(card.files, []);
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
