import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { progressiveUrls } from '../../src/cards/shared.ts';
import { fakeFetch, fixture, imageResponse } from '../../test-support/harness.ts';

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
  assert.equal(card.embeds[0]!.url, 'https://x.com/0x0SojalSec/status/2117280148445962692');
  assert.match(card.embeds[0]!.author!.name, /^Md Ismail .*\(@0x0SojalSec\)$/);
  assert.equal(card.embeds[0]!.author!.icon_url, X_VIDEO.tweet.author.avatar_url);
  assert.ok(card.embeds[0]!.description!.startsWith('Stop chatting with AI.'));
  // The video is in the message, so its poster frame is not repeated as the
  // embed image: the player already shows that frame.
  assert.equal(card.embeds[0]!.image, undefined);
  assert.equal(card.embeds[0]!.footer!.text, 'Twitter');
  // The numbers sit on one line at the end of the text. Four inline fields
  // became four stacked rows on the phone client, which is what this replaces.
  assert.ok(
    card.embeds[0]!.description!.endsWith(
      `💬 ${X_VIDEO.tweet.replies.toLocaleString('en-US')} · ` +
      `🔁 ${X_VIDEO.tweet.retweets.toLocaleString('en-US')} · ` +
      `❤️ ${X_VIDEO.tweet.likes.toLocaleString('en-US')} · ` +
      `👁 ${X_VIDEO.tweet.views.toLocaleString('en-US')}`,
    ),
  );
  assert.equal(card.embeds[0]!.fields, undefined, 'no field per number');
  assert.equal(card.embeds[0]!.timestamp, new Date(X_VIDEO.tweet.created_timestamp * 1000).toISOString());
  // The video itself comes with the card, as an attachment: an embed cannot
  // hold one, and Discord plays an attached MP4.
  assert.equal(card.files.length, 1);
  assert.equal(card.files[0]!.name, 'video.mp4');
  assert.deepEqual(card.files[0]!.attachment, MP4_BYTES);
  assert.equal(card.embeds.length, 1);
});

test('a video over the budget becomes a follow-up, not a dead poster', async () => {
  const huge = new Response(MP4_BYTES, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(12 * 1024 * 1024) },
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
  // The follow-up message will play, so the poster frame would be a duplicate.
  assert.equal(card.embeds[0]!.image, undefined);
  assert.equal(card.followUp, X_VIDEO.tweet.media.all[0].url);
});

test('a rendition over the budget is skipped so a smaller one can play', async () => {
  // Shaped like the real OHIOISONFIRE video: a high-bitrate rendition over the
  // upload limit, and a lower one that fits.
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
    [big, new Response(MP4_BYTES, { status: 200, headers: { 'content-length': String(11_000_000) } })],
    [small, mp4Response()],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });

  assert.equal(card!.files.length, 1);
  assert.deepEqual(card!.files[0]!.attachment, MP4_BYTES);
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

  assert.equal(card!.files.length, 1);
});

test('X card for a text-only tweet has no image', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);
  const [card] = await buildCards('https://twitter.com/jack/status/20', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds[0]!.image, undefined);
  // `views` is null in the fixture, so it is left out of the line.
  assert.equal(
    card.embeds[0]!.description,
    'just setting up my twttr\n\n💬 18,814 · 🔁 125,742 · ❤️ 321,681',
  );
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
  assert.match(card.embeds[0]!.description!, /> \*\*Quoting Jack \(@jack\)\*\*/);
  assert.match(card.embeds[0]!.description!, /> \\\*original\\\* thought\n> second line/);
});

test('X card escapes markdown in the tweet text', async () => {
  const hostile = {
    ...X_TEXT,
    tweet: { ...X_TEXT.tweet, text: '__not italic__ and <@123456789012345678>' },
  };
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', hostile]]);
  const [card] = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });

  assert.ok(
    card!.embeds[0]!.description!.startsWith('\\_\\_not italic\\_\\_ and <@123456789012345678>'),
  );
});

test('X card gives each photo its own full-size embed', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TWO_PHOTOS]]);
  const [card] = await buildCards('https://x.com/EspokunCity/status/2117605067968930228', {
    fetchImpl: impl,
  });

  assert.equal(card!.embeds.length, 2);
  assert.equal(card!.embeds[0]!.image!.url, X_TWO_PHOTOS.tweet.media.all[0].url);
  assert.equal(card!.embeds[1]!.image!.url, X_TWO_PHOTOS.tweet.media.all[1].url);
  assert.equal(card!.embeds[1]!.thumbnail, undefined, 'no shrunken image');
  assert.ok(card!.embeds[0]!.description, 'the text lives on the first embed');
  assert.equal(card!.embeds[1]!.description, undefined, 'and is not repeated');
  assert.deepEqual(card!.files, [], 'no upload needed: Discord fetches pbs directly');
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

  assert.equal(card!.embeds.length, 4);
  assert.deepEqual(
    card!.embeds.map((embed) => embed.image!.url),
    four.tweet.media.all.map((photo: { url: string }) => photo.url),
  );
  assert.deepEqual(card!.files, []);
});

test('a quote tweet\'s photos join the card, after the main tweet\'s', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_QUOTE_PHOTOS]]);
  const [card] = await buildCards('https://x.com/someone/status/2117268467812331634', {
    fetchImpl: impl,
  });

  const expected = [
    ...X_QUOTE_PHOTOS.tweet.media.all.map((item: { url: string }) => item.url),
    ...X_QUOTE_PHOTOS.tweet.quote.media.all.map((item: { url: string }) => item.url),
  ];
  assert.equal(card!.embeds.length, 4);
  assert.deepEqual(card!.embeds.map((embed) => embed.image!.url), expected);
  assert.deepEqual(
    card!.embeds.map((embed) => embed.footer!.text),
    ['Twitter · 1/4', 'Twitter · 2/4', 'Twitter · 3/4', 'Twitter · 4/4'],
  );
  // The quoted words are already a blockquote, so the pictures follow it.
  assert.match(card!.embeds[0]!.description!, /> \*\*Quoting Meituan LongCat \(@Meituan\\_LongCat\)\*\*/);
  assert.equal(card!.embeds[1]!.description, undefined, 'later embeds stay images only');
});

test('a counted footer only appears when there is more than one image', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_VIDEO]]);
  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });
  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.footer!.text, 'Twitter');
});

test('a dropped request is retried once before the card is lost', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);
  let attempts = 0;
  const flaky: typeof fetch = async (url, init) => {
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

test('a body with no content-length is counted while it streams, and refused past the limit', async () => {
  // A chunked response declares no length; the size is only known by reading.
  // Every rendition gets its own stream; record the most read from any one.
  let pulled = 0;
  const chunk = Buffer.alloc(1024 * 1024);
  const endless = () => {
    let reads = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        reads += 1;
        pulled = Math.max(pulled, reads);
        controller.enqueue(chunk);
        if (reads > 50) controller.close();
      },
    }), { status: 200 });
  };
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', X_VIDEO],
    ['https://video.twimg.com/', endless],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });

  assert.deepEqual(card!.files, [], 'nothing attached');
  assert.equal(card!.followUp, X_VIDEO.tweet.media.all[0].url, 'a live URL refused for size still plays');
  assert.ok(pulled <= 12, `stopped near the limit, not at the end (read ${pulled} MiB)`);
});

test('a follow-up uses the largest rendition Discord still unfurls, not the largest file', async () => {
  // Measured on a real Facebook video: the 39.5 MB `hd` file got no player
  // from a bare link, the 8.5 MB `sd` one did. 12 MB and 20 MB stand either side
  // of the unfurl limit, both over the upload budget.
  const tweet = structuredClone(X_VIDEO);
  const sized = (bytes: number) => () => new Response(MP4_BYTES, {
    status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes) },
  });
  const urls = ['huge', 'mid', 'small'].map((n) => `https://video.twimg.com/amplify_video/1/vid/${n}.mp4`);
  tweet.tweet.media.all[0].url = urls[0];
  tweet.tweet.media.all[0].formats = urls.map((url, i) => ({ url, bitrate: 3e6 - i * 1e6, container: 'mp4' }));
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', tweet],
    [urls[0]!, sized(39_458_600)],
    [urls[1]!, sized(20_000_000)],
    [urls[2]!, sized(12_000_000)],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });

  assert.deepEqual(card!.files, []);
  assert.equal(card!.followUp, urls[2]);
});

test('no follow-up when every rendition is too large for Discord to play', async () => {
  const tweet = structuredClone(X_VIDEO);
  const sized = (bytes: number) => () => new Response(MP4_BYTES, {
    status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes) },
  });
  const urls = ['huge', 'big'].map((n) => `https://video.twimg.com/amplify_video/1/vid/${n}.mp4`);
  tweet.tweet.media.all[0].url = urls[0];
  tweet.tweet.media.all[0].formats = urls.map((url, i) => ({ url, bitrate: 3e6 - i * 1e6, container: 'mp4' }));
  const { impl } = fakeFetch([
    ['https://api.fxtwitter.com/', tweet],
    [urls[0]!, sized(39_458_600)],
    [urls[1]!, sized(20_000_000)],
  ]);

  const [card] = await buildCards('https://x.com/someone/status/2117280148445962692', { fetchImpl: impl });

  assert.deepEqual(card!.files, []);
  assert.equal(card!.followUp, undefined, 'a link that cannot play is noise');
});

test('yt-dlp renditions keep only complete files, best first', () => {
  // Shape of `yt-dlp -J` on facebook.com/kizaragieril/videos/29857166957218154.
  const info = { formats: [
    { format_id: 'audio', url: 'https://a/audio.m4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.5' },
    { format_id: 'sd', url: 'https://a/sd.mp4', protocol: 'https' },
    { format_id: 'hd', url: 'https://a/hd.mp4', protocol: 'https' },
    { format_id: 'dash', url: 'https://a/v.mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none' },
    { format_id: 'hls', url: 'https://a/x.m3u8', protocol: 'm3u8_native', vcodec: 'avc1', acodec: 'mp4a' },
  ] };
  assert.deepEqual(progressiveUrls(info), ['https://a/hd.mp4', 'https://a/sd.mp4']);
  assert.deepEqual(progressiveUrls({}), []);
});
