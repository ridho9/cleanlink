import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildCards, escapeMarkdown, toField } from '../src/cards.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const X_VIDEO = fixture('x-video.json');
const X_TEXT = fixture('x-text.json');
const PIXIV = fixture('pixiv-illust.json');
const PIXIV_PAGES = fixture('pixiv-pages.json');

/** A fetch stub that answers by URL prefix and records what it was asked. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes.find(([prefix]) => String(url).startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    const [, value] = route;
    // A Response body can be read once, so hand out a clone per request; the
    // pixiv builder fetches the same image host several times.
    if (value instanceof Response) return value.clone();
    if (typeof value === 'string') return new Response(value, { status: 200 });
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function imageResponse() {
  return new Response(IMAGE_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

test('escapeMarkdown neutralises Discord markdown', () => {
  assert.equal(escapeMarkdown('*bold* _it_ ~strike~ `code` | table'), '\\*bold\\* \\_it\\_ \\~strike\\~ \\`code\\` \\| table');
  assert.equal(escapeMarkdown('> quoted'), '\\> quoted');
  assert.equal(escapeMarkdown('- list'), '\\- list');
  assert.equal(escapeMarkdown('1. ordered'), '1\\. ordered');
  assert.equal(escapeMarkdown('plain text'), 'plain text');
  assert.equal(escapeMarkdown(undefined), '');
});

test('toField clips inside the limit and never leaves a dangling escape', () => {
  assert.equal(toField('abc', 10), 'abc');

  const clipped = toField('x'.repeat(50), 10);
  assert.equal(clipped.length, 10);
  assert.ok(clipped.endsWith('…'));

  // 9 characters then a markdown char: escaping grows the string, so the cut
  // can land between the backslash and the character it protects.
  const edge = toField(`${'a'.repeat(8)}*`, 10);
  assert.equal(edge.length, 10);
  assert.ok(!edge.endsWith('\\…'));
});

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
  assert.equal(card.embed.url, 'https://x.com/0x0SojalSec/status/2117280148445962692');
  assert.match(card.embed.author.name, /^Md Ismail .*\(@0x0SojalSec\)$/);
  assert.equal(card.embed.author.icon_url, X_VIDEO.tweet.author.avatar_url);
  assert.ok(card.embed.description.startsWith('Stop chatting with AI.'));
  // No photo in this tweet: the poster frame stands in for the video.
  assert.equal(card.embed.image.url, X_VIDEO.tweet.media.all[0].thumbnail_url);
  assert.equal(card.embed.footer.text, 'Twitter');
  assert.deepEqual(
    card.embed.fields.map((field) => field.name),
    ['Replies', 'Retweets', 'Likes', 'Views'],
  );
  assert.equal(
    card.embed.fields.find((field) => field.name === 'Views').value,
    X_VIDEO.tweet.views.toLocaleString('en-US'),
  );
  assert.equal(card.embed.timestamp, new Date(X_VIDEO.tweet.created_timestamp * 1000).toISOString());
  assert.deepEqual(card.files, []);
});

test('X card for a text-only tweet has no image', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);
  const [card] = await buildCards('https://twitter.com/jack/status/20', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embed.image, undefined);
  assert.equal(card.embed.description, 'just setting up my twttr');
  assert.deepEqual(card.embed.fields.map((field) => field.name), ['Replies', 'Retweets', 'Likes']);
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
  assert.match(card.embed.description, /> \*\*Quoting Jack \(@jack\)\*\*/);
  assert.match(card.embed.description, /> \\\*original\\\* thought\n> second line/);
});

test('X card escapes markdown in the tweet text', async () => {
  const hostile = {
    ...X_TEXT,
    tweet: { ...X_TEXT.tweet, text: '__not italic__ and <@123456789012345678>' },
  };
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', hostile]]);
  const [card] = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });

  assert.equal(card.embed.description, '\\_\\_not italic\\_\\_ and <@123456789012345678>');
});

test('X card is skipped when the API fails', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', new Response('gone', { status: 404 })]]);
  const cards = await buildCards('https://x.com/jack/status/20', { fetchImpl: impl });
  assert.deepEqual(cards, []);
});

test('Pixiv card re-hosts the pages, because Discord cannot fetch pximg', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embed.url, 'https://www.pixiv.net/artworks/151616953');
  assert.equal(card.embed.author.name, PIXIV.body.userName);
  assert.equal(card.embed.author.url, `https://www.pixiv.net/users/${PIXIV.body.userId}`);
  assert.equal(card.embed.title, PIXIV.body.illustTitle);
  assert.equal(card.files.length, PIXIV_PAGES.body.length);
  assert.deepEqual(card.files.map((file) => file.name), ['p0.jpg', 'p1.jpg']);
  assert.equal(card.embed.image.url, 'attachment://p0.jpg');
  assert.match(card.embed.footer.text, /^Pixiv · 2 page/);
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
  assert.equal(card.embed.image.url, 'attachment://SPOILER_p0.jpg');
  assert.equal(card.embed.footer.text, 'Pixiv · restricted');
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

test('buildCards stops at the image budget', async () => {
  const heavy = {
    ...PIXIV,
    body: { ...PIXIV.body, pageCount: 9 },
  };
  const pages = {
    body: Array.from({ length: 9 }, (_, index) => ({
      urls: { regular: `https://i.pximg.net/img-master/img/x_p${index}_master1200.jpg` },
    })),
  };
  // 6 MB each: the second page would pass 8 MB, so only the first survives.
  const big = new Response(Buffer.alloc(6_000_000), { status: 200 });
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', pages],
    ['https://www.pixiv.net/ajax/illust/151616953', heavy],
    ['https://i.pximg.net/', big],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });
  assert.equal(card.files.length, 1);
});

test('buildCards only cards the listed sites, once, and in order', async () => {
  const { impl, calls } = fakeFetch([
    ['https://api.fxtwitter.com/', X_TEXT],
    ['https://www.pixiv.net/', PIXIV],
  ]);

  const text = [
    'https://example.com/not-ours',
    'https://x.com/jack/status/20',
    'https://x.com/jack/status/20',
    'https://www.pixiv.net/artworks/151616953',
  ].join(' ');

  const cards = await buildCards(text, { fetchImpl: impl });
  assert.equal(cards.length, 1, 'one card per message');
  assert.equal(cards[0].from, 'https://x.com/jack/status/20');
  assert.equal(calls.length, 1, 'the second site is never queried');
});
