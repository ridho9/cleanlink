import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { fakeFetch, fixture, fixtureText, imageResponse } from '../../test-support/harness.ts';

const REEL_HTML = fixtureText('instagram-reel.html');
const CAROUSEL_PAGE = fixtureText('instagram-carousel-page.html');
const EMBED_CAROUSEL = fixtureText('instagram-embed-carousel.html');
const EMBED_VIDEO = fixtureText('instagram-embed-video.html');
const OEMBED = fixture('instagram-oembed.json');
const SINGLE_PAGE = fixtureText('instagram-single.html');

// The reel's frame, as each page reports it.
const EMBED_FRAME = /"display_url":"([^"]+)"/.exec(EMBED_VIDEO.replace(/\\/g, ''))![1];
const OG_IMAGE = /property="og:image" content="([^"]+)"/.exec(REEL_HTML)![1].replace(/&amp;/g, '&');
const URL = 'https://www.instagram.com/reel/DcuMLVagTPh/';
const VIDEO_URL = /"video_url":"([^"]+)"/.exec(EMBED_VIDEO.replace(/\\/g, ''))![1];
const MP4_BYTES = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
const mp4 = (length = MP4_BYTES.length) =>
  new Response(MP4_BYTES, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(length) },
  });

test('an Instagram photo post is carded from its OpenGraph tags', async () => {
  const { impl, calls } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(calls[0].headers['user-agent'], 'Mozilla/5.0');

  const embed = card.embeds[0];
  assert.equal(embed.author!.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.equal(embed.author!.url, 'https://www.instagram.com/abdulelsayed/');
  assert.equal(embed.url, 'https://www.instagram.com/abdulelsayed/reel/DcuMLVagTPh/');
  assert.ok(embed.description!.startsWith('Heard there’s a reunion happening tonight?'));
  assert.ok(embed.image!.url.startsWith('https://scontent.cdninstagram.com/'));
  assert.equal(embed.footer!.text, 'Instagram');

  const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
  assert.deepEqual(fields, { Likes: '1M', Comments: '11K' });
  assert.equal(card.followUp, undefined);
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
    card.embeds.every((embed) => embed.image!.url.startsWith('https://instagram.')),
    'every image is a signed Instagram CDN URL, not a third-party proxy',
  );
  assert.equal(new Set(card.embeds.map((embed) => embed.image!.url)).size, 4, 'four distinct images');
  assert.deepEqual(
    card.embeds.map((embed) => embed.footer!.text),
    ['Instagram · 1/4', 'Instagram · 2/4', 'Instagram · 3/4', 'Instagram · 4/4'],
  );
  assert.ok(calls.some((call) => call.url.includes('/embed/captioned/')));
  assert.ok(!calls.some((call) => call.url.includes('vxinstagram')), 'no third party is asked');

  assert.equal(card.embeds[0].author!.name, 'Event Organizer Padang (@kaluma.organizer)');
  assert.equal(card.embeds[0].author!.url, 'https://www.instagram.com/kaluma.organizer/');
  assert.deepEqual(
    card.embeds[0].fields!.map((field) => `${field.name}=${field.value}`),
    ['Likes=12', 'Comments=0'],
  );
  assert.equal(card.embeds[1].author, undefined, 'the rest are images only');
});

test('a single-image post falls back to the page image and has no page counter', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });

  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].footer!.text, 'Instagram');
  assert.ok(card.embeds[0].image!.url.startsWith('https://scontent.cdninstagram.com/'));
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
  assert.match(embed.author!.name, /\(@chinese\\_mandarin\\_zest\)$/, 'the handle is escaped for markdown');
  assert.match(embed.author!.name, /^Mandarin Zest/, 'the display name comes from the page');
  assert.equal(embed.author!.url, 'https://www.instagram.com/chinese_mandarin_zest/');
  // The OpenGraph caption is clipped; oEmbed's is not.
  assert.ok(embed.description!.startsWith('✡️ How do you talk about Judaism in Chinese?'));
  // The thumbnail keeps its aspect ratio instead of a square crop.
  assert.equal(embed.image!.url, OEMBED.thumbnail_url);
  assert.ok(!embed.image!.url.includes('s640x640'), 'not the square crop');
});

test('a reel whose video cannot be fetched keeps the clean frame', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/p/DcuMLVagTPh/embed/captioned/', EMBED_VIDEO],
    ['https://www.instagram.com/', REEL_HTML],
  ]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author!.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.ok(card.embeds[0].description!.startsWith('Heard there’s a reunion'));

  // The frame comes from the embed payload, not `og:image` — Instagram bakes a
  // play button into the OpenGraph thumbnail.
  assert.equal(card.embeds[0].image!.url, EMBED_FRAME);
  assert.notEqual(card.embeds[0].image!.url, OG_IMAGE);
  assert.equal(card.followUp, undefined, 'a dead video URL is not offered');
  assert.deepEqual(card.files, []);
});

test('a reel that fits the budget carries its video, not the frame', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/p/DcuMLVagTPh/embed/captioned/', EMBED_VIDEO],
    ['https://www.instagram.com/', REEL_HTML],
    [VIDEO_URL, mp4()],
  ]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].name, 'video.mp4');
  assert.equal(card.embeds[0].image, undefined, 'the player replaces the frame');
  assert.equal(card.followUp, undefined);
});

test('a reel over the budget follows up with its video URL', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/p/DcuMLVagTPh/embed/captioned/', EMBED_VIDEO],
    ['https://www.instagram.com/', REEL_HTML],
    [VIDEO_URL, mp4(15 * 1024 * 1024)],
  ]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.deepEqual(card.files, []);
  assert.equal(card.followUp, VIDEO_URL);
  assert.equal(card.embeds[0].image, undefined);
  assert.ok(card.embeds[0].description, 'the card keeps the caption');
});

test('a login wall with no mirror answering gets no card', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', '<html><head></head></html>']]);
  const cards = await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});

const LOGIN_WALL = '<html><head><title>Login • Instagram</title></head></html>';
const PREVIEW = 'https://www.oginstagram.com/offload/DeKG8FGDKX3/1?thumbnail=1&sig=x';
const mirrorPage = (title: string, description: string, image = PREVIEW) =>
  `<html><head><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${image}"></head></html>`;
const video = () => new Response('', { status: 200, headers: { 'content-type': 'video/mp4' } });

test('behind a login wall, oginstagram gives the text and vxinstagram the other images', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/', LOGIN_WALL],
    ['https://www.oginstagram.com/p/DeKG8FGDKX3/', mirrorPage('Nil Mısırlıoğlu (@nilsworks)', '🖼️ 3 ❤️ 3,578 💬 47 Best villainess manhwa ever')],
    ['https://vxinstagram.com/offload/', imageResponse()],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DeKG8FGDKX3/', { fetchImpl: impl });

  assert.equal(card!.embeds[0]!.author!.name, 'Nil Mısırlıoğlu (@nilsworks)');
  assert.equal(card!.embeds[0]!.description, 'Best villainess manhwa ever');
  assert.deepEqual(card!.embeds[0]!.fields!.map((field) => field.value), ['3,578', '47']);
  // The count comes from oginstagram: vxinstagram repeats its last image past the end.
  assert.deepEqual(card!.embeds.map((embed) => embed.image?.url), [
    PREVIEW,
    'https://vxinstagram.com/offload/DeKG8FGDKX3/1',
    'https://vxinstagram.com/offload/DeKG8FGDKX3/2',
  ]);
  assert.ok(card!.embeds.every((embed) => embed.url === 'https://www.instagram.com/p/DeKG8FGDKX3/'), 'one gallery, linked to Instagram');
});

test('a carousel item that is a video is left out, not shown as a broken image', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.instagram.com/', LOGIN_WALL],
    ['https://www.oginstagram.com/', mirrorPage('Nil (@nilsworks)', '🖼️ 3 ❤️ 3 💬 9 caption')],
    ['https://vxinstagram.com/offload/DeKG8FGDKX3/1', video()],
    ['https://vxinstagram.com/offload/', imageResponse()],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DeKG8FGDKX3/', { fetchImpl: impl });

  assert.deepEqual(card!.embeds.map((embed) => embed.image?.url), [PREVIEW, 'https://vxinstagram.com/offload/DeKG8FGDKX3/2']);
  assert.deepEqual(card!.embeds.map((embed) => embed.footer?.text), ['Instagram · 1/2', 'Instagram · 2/2']);
  assert.ok(!calls.some((call) => call.url === PREVIEW), 'the signed preview is not fetched by the bot');
});

test('a reel behind a login wall shows oginstagram\'s still', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/', LOGIN_WALL],
    ['https://www.oginstagram.com/', mirrorPage('Zerven (@zervennn)', '❤️ 1,670 💬 14 Mie ayam date')],
    ['https://vxinstagram.com/offload/', video()],
  ]);
  const [card] = await buildCards('https://www.instagram.com/reel/DfNefQ7kv-r/', { fetchImpl: impl });

  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.description, 'Mie ayam date');
  assert.equal(card!.embeds[0]!.image!.url, PREVIEW);
});

test('when oginstagram fails too, vxinstagram gives the text and one image', async () => {
  const { impl } = fakeFetch([
    ['https://www.instagram.com/', LOGIN_WALL],
    ['https://vxinstagram.com/p/DeKG8FGDKX3/', mirrorPage('Nil (@nilsworks)', 'Best villainess manhwa ever')],
    ['https://vxinstagram.com/offload/', imageResponse()],
  ]);
  const [card] = await buildCards('https://www.instagram.com/p/DeKG8FGDKX3/', { fetchImpl: impl });

  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.author!.name, 'Nil (@nilsworks)');
  assert.equal(card!.embeds[0]!.fields, undefined);
  assert.equal(card!.embeds[0]!.image!.url, 'https://vxinstagram.com/offload/DeKG8FGDKX3/0');
});

test('a working Instagram page never touches the mirrors', async () => {
  const { impl, calls } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  await buildCards('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });
  assert.ok(calls.every((call) => call.url.startsWith('https://www.instagram.com/')));
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
