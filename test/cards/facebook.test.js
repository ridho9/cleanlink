import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixtureText } from '../../test-support/harness.js';

const FACEBOOK_HTML = fixtureText('facebook-post.html');
const FACEBOOK_REEL = fixtureText('facebook-reel.html');
const FACEBOOK_FEED = fixtureText('facebook-feed.html');
const FACEBOOK_BLOCKED = fixtureText('facebook-video-blocked.html');

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

test('Facebook card reads a reel and a watch link, and ignores UI labels', async () => {
  // A reel page carries several aria-labels ("Putar video", "Putar Cerita …");
  // only the avatar <img role="img"> holds the author name.
  const reel = FACEBOOK_REEL.replace(
    '<body>',
    '<body><span aria-label="Putar video"></span><span aria-label="Putar Cerita yang belum dilihat"></span>',
  );
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', reel]]);

  for (const url of [
    'https://www.facebook.com/reel/1543457311150597/',
    'https://www.facebook.com/watch/?v=1543457311150597',
    'https://www.facebook.com/someone/videos/1543457311150597',
  ]) {
    const [card] = await buildCards(url, { fetchImpl: impl });
    assert.ok(card, url);
    assert.equal(card.embeds[0].author.name, 'Lingua Forge', url);
    assert.ok(card.embeds[0].description.startsWith('Siapa bilang persiapan'), url);
    assert.ok(card.embeds[0].image, url);
  }
});

test('Facebook card resolves from a /share/ link through the cleaned URL', async () => {
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', FACEBOOK_REEL]]);
  const raw = 'https://www.facebook.com/share/r/1RrEeLlSsX/';
  const [card] = await buildCards(raw, {
    fetchImpl: impl,
    cleaned: [{ from: raw, to: 'https://www.facebook.com/reel/1543457311150597/' }],
  });

  assert.ok(card);
  assert.equal(card.url, 'https://www.facebook.com/reel/1543457311150597/');
});

test('Facebook card retries once on an unexpected response', async () => {
  const calls = [];
  const { impl } = fakeFetch([
    ['https://www.facebook.com/plugins/post.php', FACEBOOK_REEL],
  ]);
  // First answer is an interstitial, second is the real page.
  const flaky = async (url, init) => {
    calls.push(url);
    if (calls.length === 1) return new Response('<html>checkpoint</html>', { status: 200 });
    return impl(url, init);
  };

  const [card] = await buildCards('https://www.facebook.com/reel/1543457311150597/', {
    fetchImpl: flaky,
  });

  assert.ok(card, 'the retry must recover');
  assert.equal(
    calls.filter((url) => url.startsWith('https://www.facebook.com/plugins/')).length,
    2,
  );
});

test('Facebook card does not retry a post that refuses embedding', async () => {
  const refused = '<html><body>Postingan Facebook ini tidak tersedia lagi.</body></html>';
  const { impl, calls } = fakeFetch([['https://www.facebook.com/plugins/post.php', refused]]);

  const cards = await buildCards('https://www.facebook.com/reel/1543457311150597/', {
    fetchImpl: impl,
  });

  assert.deepEqual(cards, []);
  const pluginCalls = calls.filter(({ url }) => url.startsWith('https://www.facebook.com/plugins/'));
  assert.equal(pluginCalls.length, 1, 'a refusal is final, not a hiccup');
});

// Facebed serves a post's OpenGraph tags to a crawler where Facebook serves a
// login wall. It is read for its tags only; the message keeps the Facebook URL.
const FACEBED_POST = `<html><head>
<meta property="og:title" content="Videogame screenshots out of context"/>
<meta property="og:description" content=""/>
<meta property="og:url" content="https://www.facebook.com/Videogamesoutofcontext/posts/1603794385111948"/>
<meta property="og:image" content="https://scontent.fhan5-10.fna.fbcdn.net/v/t39.99422-6/886082637_1679750246913158_n.jpg"/>
</head><body></body></html>`;

test('a post the plugin refuses is carded from facebed instead', async () => {
  const refused = '<html><body>Postingan Facebook ini tidak tersedia lagi.</body></html>';
  const { impl, calls } = fakeFetch([
    ['https://www.facebook.com/plugins/post.php', refused],
    ['https://www.facebed.com/', FACEBED_POST],
  ]);

  const [card] = await buildCards(
    'https://www.facebook.com/100064442061829/posts/1603794385111948/',
    { fetchImpl: impl },
  );

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  assert.equal(card.embeds[0].author.name, 'Videogame screenshots out of context');
  assert.equal(
    card.embeds[0].image.url,
    'https://scontent.fhan5-10.fna.fbcdn.net/v/t39.99422-6/886082637_1679750246913158_n.jpg',
  );
  assert.equal(card.embeds[0].url, 'https://www.facebook.com/100064442061829/posts/1603794385111948/');
  assert.ok(
    calls.some(({ url }) => url.startsWith('https://www.facebed.com/')),
    'the mirror was asked',
  );
});

const FACEBED_REEL = `<html><head>
<meta property="og:title" content="Diarycoffee Jktt"/>
<meta property="og:description" content="Baru tau di dekat Jakarta ada tempat seseru ini"/>
<meta property="og:url" content="https://www.facebook.com/diarycoffeejkt/reel/2241600476763618"/>
<meta property="og:image" content="https://scontent.fhan5-11.fna.fbcdn.net/v/t15.5256-10/thumb.jpg"/>
<meta property="og:video" content="https://video.fhan5-11.fna.fbcdn.net/o1/v/t2/f2/m412/reel.mp4"/>
</head></html>`;

const VIDEO_MP4 = () =>
  new Response(Buffer.alloc(2048), { status: 200, headers: { 'content-type': 'video/mp4' } });

/** The plugin page is refused, so the mirror is the only source. */
const reelRoutes = (video) => [
  ['https://www.facebook.com/plugins/post.php', '<html>tidak tersedia lagi</html>'],
  ['https://www.facebed.com/', FACEBED_REEL],
  ['https://video.fhan5-11.fna.fbcdn.net/', video],
];

test('a facebed reel is attached when the file fits', async () => {
  const { impl } = fakeFetch(reelRoutes(VIDEO_MP4()));

  const [card] = await buildCards('https://www.facebook.com/reel/2241600476763618/', {
    fetchImpl: impl,
  });

  assert.equal(card.files.length, 1);
  assert.equal(card.followUp, undefined);
  assert.equal(card.embeds[0].author.name, 'Diarycoffee Jktt');
  assert.equal(card.embeds[0].description, 'Baru tau di dekat Jakarta ada tempat seseru ini');
  assert.equal(card.embeds[0].image, undefined, 'the player brings its own frame');
});

test('a facebed reel past the budget hands the link to the mirror page', async () => {
  const tooBig = () =>
    new Response('x', {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '24531746' },
    });
  const { impl } = fakeFetch(reelRoutes(tooBig()));

  const [card] = await buildCards('https://www.facebook.com/reel/2241600476763618/', {
    fetchImpl: impl,
  });

  assert.equal(card.files.length, 0);
  assert.deepEqual(card.embeds, []);
  // The CDN URL produced no embed when posted alone; the page does, so it
  // becomes the link that Discord unfurls.
  assert.equal(card.url, 'https://www.facebed.com/reel/2241600476763618/');
  assert.equal(card.unfurl, true);
});

test('a facebed login wall is still no card', async () => {
  const refused = '<html><body>tidak tersedia lagi</body></html>';
  const wall = `<html><head>
<meta property="og:title" content="Log in or sign up to view"/>
<meta property="og:description" content="See posts, photos and more on Facebook."/>
</head></html>`;
  const { impl } = fakeFetch([
    ['https://www.facebook.com/plugins/post.php', refused],
    ['https://www.facebed.com/', wall],
  ]);

  const cards = await buildCards('https://www.facebook.com/reel/1543457311150597/', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});

test('a post that comes back as a page feed is still carded', async () => {
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', FACEBOOK_FEED]]);
  const [card] = await buildCards(
    'https://www.facebook.com/100064442061829/posts/1603794385111948/',
    { fetchImpl: impl },
  );

  assert.ok(card);
  assert.equal(card.embeds.length, 1);
  // The feed layout has no post_message; the name is only in the avatar aria-label.
  assert.equal(card.embeds[0].author.name, 'Videogame screenshots out of context');
  assert.equal(card.embeds[0].author.url, 'https://www.facebook.com/Videogamesoutofcontext');
  assert.ok(card.embeds[0].image.url.includes('/t39.30808-6/'), 'the post picture');
  assert.ok(!card.embeds[0].image.url.includes('/t39.30808-1/'), 'not the avatar');
  assert.equal(card.embeds[0].footer.text, 'Facebook');
});

test('a feed showing a different post is not carded', async () => {
  const other = FACEBOOK_FEED.replace('1603794385111948', '9999999999999999');
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', other]]);
  const cards = await buildCards(
    'https://www.facebook.com/100064442061829/posts/1603794385111948/',
    { fetchImpl: impl },
  );
  assert.deepEqual(cards, [], 'the id in the widget must be the one requested');
});

test('a video Facebook will not play still gets a card naming its owner', async () => {
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', FACEBOOK_BLOCKED]]);
  const [card] = await buildCards('https://www.facebook.com/reel/1473617888008342', {
    fetchImpl: impl,
  });

  assert.ok(card, 'Discord shows only "Log in or sign up to view" for this link');
  const embed = card.embeds[0];
  assert.equal(embed.author.name, 'Know Your Meme Indonesia - Unofficial');
  assert.equal(embed.image, undefined, 'there is no media to show');
  assert.match(embed.description, /not logged in/);
  assert.equal(embed.footer.text, 'Facebook');
});

test('Facebook card is skipped for a post that forbids embedding', async () => {
  const blocked = '<html><body><h2>Postingan Facebook ini tidak tersedia lagi.</h2></body></html>';
  const { impl } = fakeFetch([['https://www.facebook.com/plugins/post.php', blocked]]);
  const cards = await buildCards('https://www.facebook.com/NASA/posts/pfbid02uH6kjwWSmyXozUDNbPndAcJBZXU3b5P8kQJdWi3ShU75f7nooWuirXdHAgKLqvggl', {
    fetchImpl: impl,
  });
  assert.deepEqual(cards, []);
});
