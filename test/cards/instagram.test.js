import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixtureText } from '../../test-support/harness.js';

const REEL_HTML = fixtureText('instagram-reel.html');
const URL = 'https://www.instagram.com/reel/DcuMLVagTPh/';

test('Instagram card is built because Discord shows nothing for the link', async () => {
  const { impl, calls } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card);
  assert.equal(calls[0].headers['user-agent'], 'Mozilla/5.0');

  const embed = card.embeds[0];
  assert.equal(embed.author.name, 'Dr. Abdul El-Sayed (@abdulelsayed)');
  assert.equal(embed.author.url, 'https://www.instagram.com/abdulelsayed/');
  assert.equal(embed.url, 'https://www.instagram.com/abdulelsayed/reel/DcuMLVagTPh/');
  assert.ok(embed.description.startsWith('Heard there’s a reunion happening tonight?'));
  assert.ok(!embed.description.startsWith('Dr. Abdul El-Sayed'), 'the author prefix is not repeated');
  assert.ok(embed.image.url.startsWith('https://scontent.cdninstagram.com/'));
  assert.equal(embed.footer.text, 'Instagram');

  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.deepEqual(fields, { Likes: '1M', Comments: '11K' });
});

test('Instagram card is skipped when the page has no OpenGraph title', async () => {
  const { impl } = fakeFetch([['https://www.instagram.com/', '<html><head></head></html>']]);
  const cards = await buildCards(URL, { fetchImpl: impl });
  assert.deepEqual(cards, []);
});

test('Instagram card matches every permalink shape', async () => {
  for (const url of [
    'https://www.instagram.com/p/AbCdEf12345/',
    'https://www.instagram.com/reel/DcuMLVagTPh/',
    'https://www.instagram.com/reels/DcuMLVagTPh/',
    'https://www.instagram.com/tv/AbCdEf12345/',
  ]) {
    const { impl } = fakeFetch([['https://www.instagram.com/', REEL_HTML]]);
    const [card] = await buildCards(url, { fetchImpl: impl });
    assert.ok(card, url);
  }
});
