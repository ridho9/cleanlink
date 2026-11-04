import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildCards, decodeEntities, escapeMarkdown, toField } from '../src/cards.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const X_VIDEO = fixture('x-video.json');
const X_TEXT = fixture('x-text.json');
const X_TWO_PHOTOS = fixture('x-two-photos.json');
const PIXIV = fixture('pixiv-illust.json');
const PIXIV_PAGES = fixture('pixiv-pages.json');
const TIKWM = fixture('tikwm-video.json');
const THREADS_HTML = readFileSync(new URL('./fixtures/threads-post.html', import.meta.url), 'utf8');
const FACEBOOK_HTML = readFileSync(new URL('./fixtures/facebook-post.html', import.meta.url), 'utf8');

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

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('Yoan (&#064;phodhipo)'), 'Yoan (@phodhipo)');
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), "a & b <c> \"d\" 'e'");
  assert.equal(decodeEntities('&#x2022; dot'), '• dot');
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

test('Pixiv card re-hosts the pages, because Discord cannot fetch pximg', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const [card] = await buildCards('https://www.pixiv.net/artworks/151616953', { fetchImpl: impl });

  assert.ok(card);
  assert.equal(card.embeds[0].url, 'https://www.pixiv.net/artworks/151616953');
  assert.equal(card.embeds[0].author.name, PIXIV.body.userName);
  assert.equal(card.embeds[0].author.url, `https://www.pixiv.net/users/${PIXIV.body.userId}`);
  assert.equal(card.embeds[0].title, PIXIV.body.illustTitle);
  assert.equal(card.files.length, PIXIV_PAGES.body.length);
  assert.deepEqual(card.files.map((file) => file.name), ['p0.jpg', 'p1.jpg']);
  assert.equal(card.embeds[0].image.url, 'attachment://p0.jpg');
  assert.match(card.embeds[0].footer.text, /^Pixiv · 2 page/);
  // One embed per page, all at full size. Both files are claimed, so no loose
  // attachment appears above the card.
  assert.equal(card.embeds.length, 2);
  assert.equal(card.embeds[1].image.url, 'attachment://p1.jpg');
  assert.equal(card.embeds[1].footer.text, 'Pixiv · page 2/2');
  assert.equal(card.embeds[0].thumbnail, undefined);
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
  assert.equal(card.embeds[0].image.url, 'attachment://SPOILER_p0.jpg');
  assert.equal(card.embeds[0].footer.text, 'Pixiv · restricted');
  assert.equal(card.embeds.length, 5);
  assert.equal(card.files.length, 5);
  assert.equal(card.embeds[4].image.url, 'attachment://SPOILER_p4.jpg');
  assert.equal(card.embeds[4].footer.text, 'Pixiv · page 5/5');
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

test('Threads card asks for a browser user agent and keeps the post text', async () => {
  const { impl, calls } = fakeFetch([['https://www.threads.com/', THREADS_HTML]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card);
  assert.equal(calls[0].headers['user-agent'], 'Mozilla/5.0', 'Discordbot would get no text');
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'Yoan Dipo Asani (@phodhipo)');
  assert.ok(card.embeds[0].description.startsWith('Bukan sombong ya.'));
  assert.ok(!card.embeds[0].description.includes('&'));
  assert.equal(card.embeds[0].footer.text, 'Threads');
  // A text-only post's og:image is the avatar, so it goes in the corner.
  assert.ok(card.embeds[0].thumbnail.url.includes('scontent.cdninstagram.com'));
  assert.equal(card.embeds[0].image, undefined);
});

test('Threads card shows post media large, not the avatar', async () => {
  const withMedia = THREADS_HTML.replace(
    /\/t51\.2885-19\//,
    '/t39.92108-6/',
  );
  const { impl } = fakeFetch([['https://www.threads.com/', withMedia]]);
  const [card] = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });

  assert.ok(card.embeds[0].image);
  assert.equal(card.embeds[0].thumbnail, undefined);
});

test('Threads card is skipped when the page has no description', async () => {
  const { impl } = fakeFetch([['https://www.threads.com/', '<html><head></head></html>']]);
  const cards = await buildCards('https://www.threads.com/@phodhipo/post/DfPOscPD6UR', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});

test('Facebook card reads the public embed iframe, not the login-walled page', async () => {
  const { impl, calls } = fakeFetch([['https://www.facebook.com/plugins/post.php', FACEBOOK_HTML]]);
  const [card] = await buildCards(
    'https://www.facebook.com/NASA/posts/pfbid02uH6kjwWSmyXozUDNbPndAcJBZXU3b5P8kQJdWi3ShU75f7nooWuirXdHAgKLqvggl',
    { fetchImpl: impl },
  );

  assert.ok(card);
  assert.ok(calls[0].url.startsWith('https://www.facebook.com/plugins/post.php?href='));
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'Learn With NASA');
  assert.equal(card.embeds[0].author.url, 'https://www.facebook.com/LearnWithNASA');
  assert.ok(card.embeds[0].description.startsWith('Ready for a special National STEM Day Q&A?'));
  assert.ok(!card.embeds[0].description.includes('&amp;'));
  assert.ok(!/[ \t]\n/.test(card.embeds[0].description), 'no line keeps a trailing space');
  assert.ok(card.embeds[0].image.url.startsWith('https://scontent'));
  assert.ok(!card.embeds[0].image.url.includes('s40x40'), 'the avatar is not the post image');
  assert.equal(card.embeds[0].footer.text, 'Facebook');
});

test('Facebook card is skipped for a post that forbids embedding', async () => {
  const blocked = '<html><body><h2>Postingan Facebook ini tidak tersedia lagi.</h2></body></html>';
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', blocked]]);
  const cards = await buildCards('https://www.facebook.com/NASA/posts/pfbid02uH6kjwWSmyXozUDNbPndAcJBZXU3b5P8kQJdWi3ShU75f7nooWuirXdHAgKLqvggl', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});

test('TikTok card uses tikwm for a real caption, author and cover', async () => {
  const { impl } = fakeFetch([['https://www.tikwm.com/api/', TIKWM]]);
  const [card] = await buildCards(
    'https://www.tiktok.com/@tiktok/video/7666123874932722974?_t=abc&is_from_webapp=1',
    {
      fetchImpl: impl,
      cleaned: [
        {
          from: 'https://www.tiktok.com/@tiktok/video/7666123874932722974?_t=abc&is_from_webapp=1',
          to: 'https://www.tiktok.com/@tiktok/video/7666123874932722974',
        },
      ],
    },
  );

  assert.ok(card);
  assert.equal(card.url, 'https://www.tiktok.com/@tiktok/video/7666123874932722974');
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'TikTok (@tiktok)');
  assert.equal(card.embeds[0].author.icon_url, TIKWM.data.author.avatar);
  assert.equal(card.embeds[0].description, TIKWM.data.title);
  assert.equal(card.embeds[0].image.url, TIKWM.data.cover);
  assert.deepEqual(card.embeds[0].fields.map((field) => field.name), ['Plays', 'Likes', 'Comments']);
  assert.equal(card.embeds[0].footer.text, 'TikTok');
  assert.equal(card.embeds[0].timestamp, new Date(TIKWM.data.create_time * 1000).toISOString());
});

test('TikTok card finds the video behind a short link', async () => {
  const { impl, calls } = fakeFetch([['https://www.tikwm.com/api/', TIKWM]]);
  // vm.tiktok.com carries no id: only the resolved URL does.
  const [card] = await buildCards('https://vm.tiktok.com/ZMabc123/', {
    fetchImpl: impl,
    cleaned: [
      {
        from: 'https://vm.tiktok.com/ZMabc123/',
        to: 'https://www.tiktok.com/@tiktok/video/7666123874932722974',
      },
    ],
  });

  assert.ok(card);
  assert.equal(card.url, 'https://www.tiktok.com/@tiktok/video/7666123874932722974');
  assert.match(calls[0].url, /url=https%3A%2F%2Fwww.tiktok.com%2F%40tiktok%2Fvideo%2F7666123874932722974/);
});

test('TikTok card is skipped when tikwm reports a failure', async () => {
  const { impl } = fakeFetch([['https://www.tikwm.com/api/', { code: -1, msg: 'Url parsing is failed' }]]);
  const cards = await buildCards('https://www.tiktok.com/@tiktok/video/7666123874932722974', {
    fetchImpl: impl,
  });
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
    ['https://www.pixiv.net/ajax/illust/151616953/pages', PIXIV_PAGES],
    ['https://www.pixiv.net/ajax/illust/151616953', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const text = [
    'https://example.com/not-ours',
    'https://x.com/jack/status/20',
    'https://x.com/jack/status/20',
    'https://www.pixiv.net/artworks/151616953',
  ].join(' ');

  const cards = await buildCards(text, { fetchImpl: impl });
  assert.deepEqual(cards.map((card) => card.from), [
    'https://x.com/jack/status/20',
    'https://www.pixiv.net/artworks/151616953',
  ]);
  assert.equal(calls.filter((call) => call.url.startsWith('https://api.fxtwitter.com/')).length, 1);
});

test('buildCards cards every handled link, not just the first', async () => {
  const { impl } = fakeFetch([['https://api.fxtwitter.com/', X_TEXT]]);

  const cards = await buildCards(
    'https://x.com/a/status/20 and https://x.com/b/status/21 https://twitter.com/c/status/22',
    { fetchImpl: impl },
  );

  // Every route serves the same fixture, so the ids look alike; what matters
  // is that all three inputs were carded rather than only the first.
  assert.deepEqual(cards.map((card) => card.from), [
    'https://x.com/a/status/20',
    'https://x.com/b/status/21',
    'https://twitter.com/c/status/22',
  ]);
});

test('buildCards keeps the message inside ten embeds', async () => {
  // Three five-page works: two fit (5 + 5), the third does not fit the budget.
  const page = {
    body: Array.from({ length: 5 }, (_, index) => ({
      urls: { regular: `https://i.pximg.net/img-master/img/x_p${index}_master1200.jpg` },
    })),
  };
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/1/pages', page],
    ['https://www.pixiv.net/ajax/illust/2/pages', page],
    ['https://www.pixiv.net/ajax/illust/3/pages', page],
    ['https://www.pixiv.net/ajax/illust/', PIXIV],
    ['https://i.pximg.net/', imageResponse()],
  ]);

  const cards = await buildCards(
    'https://www.pixiv.net/artworks/1 https://www.pixiv.net/artworks/2 https://www.pixiv.net/artworks/3',
    { fetchImpl: impl },
  );

  assert.equal(cards.length, 2, 'the third work had no embed budget left');
  assert.equal(cards.flatMap((card) => card.embeds).length, 10);
  assert.equal(cards.flatMap((card) => card.files).length, 10);
});

test('buildCards shares the attachment byte budget across cards', async () => {
  const page = {
    body: [{ urls: { regular: 'https://i.pximg.net/img-master/img/x_p0_master1200.jpg' } }],
  };
  // 6 MB each: the first card fits, the second has only 2 MB left.
  const big = new Response(Buffer.alloc(6_000_000), { status: 200 });
  const { impl } = fakeFetch([
    ['https://www.pixiv.net/ajax/illust/1/pages', page],
    ['https://www.pixiv.net/ajax/illust/2/pages', page],
    ['https://www.pixiv.net/ajax/illust/', PIXIV],
    ['https://i.pximg.net/', big],
  ]);

  const cards = await buildCards(
    'https://www.pixiv.net/artworks/1 https://www.pixiv.net/artworks/2',
    { fetchImpl: impl },
  );

  assert.equal(cards.length, 1, 'the second card had no room for its image');
  assert.equal(cards[0].files.length, 1);
});
