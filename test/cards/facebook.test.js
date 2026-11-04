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
  assert.equal(calls.length, 2);
});

test('Facebook card does not retry a post that refuses embedding', async () => {
  const refused = '<html><body>Postingan Facebook ini tidak tersedia lagi.</body></html>';
  const { impl, calls } = fakeFetch([['https://www.facebook.com/plugins/post.php', refused]]);

  const cards = await buildCards('https://www.facebook.com/reel/1543457311150597/', {
    fetchImpl: impl,
  });

  assert.deepEqual(cards, []);
  assert.equal(calls.length, 1, 'a refusal is final, not a hiccup');
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
