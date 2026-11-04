import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixture, imageResponse } from '../../test-support/harness.js';

const X_VIDEO = fixture('x-video.json');
const X_TEXT = fixture('x-text.json');
const X_TWO_PHOTOS = fixture('x-two-photos.json');

test('X card carries text, author, still, stats and timestamp', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_VIDEO]]);
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
  // No photo in this tweet: the poster frame stands in for the video.
  assert.equal(card.embeds[0].image.url, X_VIDEO.tweet.media.all[0].thumbnail_url);
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
  assert.deepEqual(card.files, []);
  assert.equal(card.embeds.length, 1);
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

test('X card is skipped when the API fails', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', new Response('gone', { status: 404 })]]);
  const cards = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});
