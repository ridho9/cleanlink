import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixture, imageResponse } from '../../test-support/harness.js';

const X_VIDEO = fixture('x-video.json');
const X_TEXT = fixture('x-text.json');
const X_TWO_PHOTOS = fixture('x-two-photos.json');
const X_QUOTE_PHOTOS = fixture('x-quote-photos.json');

const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const mp4Response = () =>
  new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });

test('X card carries text, author, still, stats and timestamp', async () => {
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', X_VIDEO],
    ['https://video.twimg.com/', mp4Response()],
  ]);
  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692?s=20', {
    fetchImpl: impl,
    cleaned: [
      {
        from: 'https://x.com/someone/status/2117280148445962692?s=20',
        to: 'https://x.com/someone/status/2117280148445962692',
      },
    ],
  });

  assert.ok(card, 'expected a card');
  assert.equal(card.url, 'https://x.com/someone/status/2117280148445962692');
  assert.equal(card.embeds[0].url, 'https://x.com/0x0SojalSec/status/2117280148445962692');
  assert.match(card.embeds[0].author.name, /^Md Ismail .*\(@0x0SojalSec\)$/);
  assert.equal(card.embeds[0].author.icon_url, X_VIDEO.tweet.author.avatar_url);
  assert.ok(card.embeds[0].description.startsWith('Stop chatting with AI.'));
  // The video is in the message, so its poster frame is not repeated as the
  // embed image: the player already shows that frame.
  assert.equal(card.embeds[0].image, undefined);
  assert.equal(card.embeds[0].footer.text, 'Twitter');
  assert.deepEqual(
    card.embeds[0].fields.map((field) => field.name),
    ['Replies', 'Retweets', 'Likes', 'Views'],
  );
  assert.equal(
    card.embeds[0].fields.find((field) => field.name === 'Views').value,
    X_VIDEO.tweet.views.toLocaleString('en-US'),
  );
  assert.equal(card.embeds[0].timestamp, new Date(X_VIDEO.tweet.created_timestamp * 1000).toISOString());
  // The video itself comes with the card, as an attachment: an embed cannot
  // hold one, and Discord plays an attached MP4.
  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].name, 'video.mp4');
  assert.deepEqual(card.files[0].attachment, MP4_BYTES);
  assert.equal(card.embeds.length, 1);
});

test('X video over the message budget is dropped, the card stays', async () => {
  const huge = new Response(MP4_BYTES, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(9 * 1024 * 1024) },
  });
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', X_VIDEO],
    ['https://video.twimg.com/', huge],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', {
    fetchImpl: impl,
  });

  assert.ok(card);
  assert.deepEqual(card.files, []);
  assert.equal(card.embeds[0].image.url, X_VIDEO.tweet.media.all[0].thumbnail_url);
});

test('a rendition over the budget is skipped so a smaller one can play', async () => {
  // The real OHIOISONFIRE video: the 2176 kbps rendition is 8.21 MB, just over
  // the 8 MB limit; the 832 kbps one fits.
  const tweet = structuredClone(X_VIDEO);
  const big = 'https://video.twimg.com/amplify_video/1/vid/1280x720/big.mp4?tag=12';
  const small = 'https://video.twimg.com/amplify_video/1/vid/640x360/small.mp4?tag=12';
  tweet.tweet.media.all[0].url = big;
  tweet.tweet.media.all[0].formats = [
    { url: big, bitrate: 2176000, container: 'mp4' },
    { url: small, bitrate: 832000, container: 'mp4' },
  ];
  const { impl, calls } = fakeFetch([
    ['https://api.fxtwitter.com/', tweet],
    [big, new Response(MP4_BYTES, { status: 200, headers: { 'content-length': String(8_611_539) } })],
    [small, mp4Response()],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });

  assert.equal(card.files.length, 1);
  assert.deepEqual(card.files[0].attachment, MP4_BYTES);
  assert.ok(calls.some((c) => c.url === small), 'the smaller rendition was tried');
});

test('X video picks the MP4 when the default rendition is an HLS playlist', async () => {
  const hls = structuredClone(X_VIDEO);
  hls.tweet.media.all[0].url = 'https://video.twimg.com/amplify_video/1/pl/abc.m3u8';
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', hls],
    ['https://video.twimg.com/', mp4Response()],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', {
    fetchImpl: impl,
  });

  assert.equal(card.files.length, 1);
});

test('X card for a text-only tweet has no image', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);
  const [card] = await buildCards('https://twitter.com/jack/status/20', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds[0].image, undefined);
  assert.equal(card.embeds[0].description, 'just setting up my twttr');
  assert.deepEqual(card.embeds[0].fields.map((field) => field.name), ['Replies', 'Retweets', 'Likes']);
});

test('X card quotes a quoted tweet as a blockquote', async () => {
  const quote = {
    ...X_TEXT,
    tweet: {
      ...X_TEXT.tweet,
      quote: {
        text: '*original* thought\nsecond line',
        author: { name: 'Jack', screen_name: 'jack' },
      },
    },
  };
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', quote]]);
  const [card] = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });

  assert.ok(card);
  assert.match(card.embeds[0].description, /> \*\*Quoting Jack \(@jack\)\*\*/);
  assert.match(card.embeds[0].description, /> \\\*original\\\* thought\n> second line/);
});

test('X card escapes markdown in the tweet text', async () => {
  const hostile = {
    ...X_TEXT,
    tweet: { ...X_TEXT.tweet, text: '__not italic__ and <@123456789012345678>' },
  };
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', hostile]]);
  const [card] = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });

  assert.equal(card.embeds[0].description, '\\_\\_not italic\\_\\_ and <@123456789012345678>');
});

test('X card gives each photo its own full-size embed', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TWO_PHOTOS]]);
  const [card] = await buildCards('https://x.com/EspokunCity/status/2117605067968930228', {
    fetchImpl: impl,
  });

  assert.equal(card.embeds.length, 2);
  assert.equal(card.embeds[0].image.url, X_TWO_PHOTOS.tweet.media.all[0].url);
  assert.equal(card.embeds[1].image.url, X_TWO_PHOTOS.tweet.media.all[1].url);
  assert.equal(card.embeds[1].thumbnail, undefined, 'no shrunken image');
  assert.ok(card.embeds[0].description, 'the text lives on the first embed');
  assert.equal(card.embeds[1].description, undefined, 'and is not repeated');
  assert.deepEqual(card.files, [], 'no upload needed: Discord fetches pbs directly');
});

test('X card keeps every photo of a four-photo post', async () => {
  const four = {
    ...X_TWO_PHOTOS,
    tweet: {
      ...X_TWO_PHOTOS.tweet,
      media: {
        all: [...X_TWO_PHOTOS.tweet.media.all, ...X_TWO_PHOTOS.tweet.media.all],
      },
    },
  };
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', four],
    ['https://pbs.twimg.com/', imageResponse()],
  ]);
  const [card] = await buildCards('https://x.com/EspokunCity/status/2117605067968930228', {
    fetchImpl: impl,
  });

  assert.equal(card.embeds.length, 4);
  assert.deepEqual(
    card.embeds.map((embed) => embed.image.url),
    four.tweet.media.all.map((photo) => photo.url),
  );
  assert.deepEqual(card.files, []);
});

test('a quote tweet\'s photos join the card, after the main tweet\'s', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_QUOTE_PHOTOS]]);
  const [card] = await buildCards('https://x.com/someone/status/2117268467812331634', {
    fetchImpl: impl,
  });

  const expected = [
    ...X_QUOTE_PHOTOS.tweet.media.all.map((item) => item.url),
    ...X_QUOTE_PHOTOS.tweet.quote.media.all.map((item) => item.url),
  ];
  assert.equal(card.embeds.length, 4);
  assert.deepEqual(card.embeds.map((embed) => embed.image.url), expected);
  assert.deepEqual(
    card.embeds.map((embed) => embed.footer.text),
    ['Twitter · 1/4', 'Twitter · 2/4', 'Twitter · 3/4', 'Twitter · 4/4'],
  );
  // The quoted words are already a blockquote, so the pictures follow it.
  assert.match(card.embeds[0].description, /> \*\*Quoting Meituan LongCat \(@Meituan\\_LongCat\)\*\*/);
  assert.equal(card.embeds[1].description, undefined, 'later embeds stay images only');
});

test('a counted footer only appears when there is more than one image', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_VIDEO]]);
  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].footer.text, 'Twitter');
});

test('a dropped request is retried once before the card is lost', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);
  let attempts = 0;
  const flaky = async (url, init) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return impl(url, init);
  };

  const [card] = await buildCards('https://x.com/jack/status/20', { fetchImpl: flaky });
  assert.ok(card, 'the retry recovered the card');
  assert.equal(attempts, 2);
});

test('X card is skipped when the API fails', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', new Response('gone', { status: 404 })]]);
  const cards = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});
