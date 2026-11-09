import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { fakeFetch } from '../../test-support/harness.ts';

const POST = 'https://www.reddit.com/r/WkwkwkLand/comments/1xreva8/lagu_macam_apa_ini/';

/** The shape of a post's Atom feed, trimmed to what the builder reads. */
function feed({ title = 'LAGU MACAM APA INI?!', media = null as string | null, gallery = null as string | null } = {}) {
  // Reddit escapes the entry's HTML twice over: `&quot;` for every quote.
  const anchor = (href: string, text: string) => `&lt;a href=&quot;${href}&quot;&gt;${text}&lt;/a&gt;`;
  const link = media ? anchor(media, '[link]') : '';
  const pages = gallery ? anchor(`https://www.reddit.com/gallery/${gallery}`, 'gallery') : '';
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<entry>
<title>${title}</title>
<author><name>/u/Faketaxidriver_069</name><uri>https://www.reddit.com/user/Faketaxidriver_069</uri></author>
<content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;${anchor(POST, '&lt;img src=&quot;https://external-preview.redd.it/abc.png?width=640&amp;amp;s=1&quot; /&gt;')}&lt;/td&gt;&lt;td&gt; submitted by ${anchor('https://www.reddit.com/user/Faketaxidriver_069', '/u/Faketaxidriver_069')} &lt;br/&gt;${link}${pages}&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
<media:thumbnail url="https://external-preview.redd.it/abc.png?width=640&amp;s=1" />
</entry>
</feed>`;
}

/** The embed view's gallery markup: one page per picture, each with its previews. */
function galleryPage(pictures: string[]) {
  const previews = (media: string) => [640, 1080]
    .map((width) => `<faceplate-img src="https://preview.redd.it/life-size-acrylic-v0-${media}.png?width=${width}&amp;crop=smart&amp;auto=webp&amp;s=${media}${width}"></faceplate-img>`)
    .join('\n');
  return `<html><body><ul>${pictures
    .map((media, index) => `<li slot="page-${index + 1}" class="h-100">${previews(media)}</li>`)
    .join('\n')}</ul></body></html>`;
}

test('Reddit card names itself to Reddit and reads the post feed', async () => {
  const { impl, calls } = fakeFetch([['https://www.reddit.com/r/WkwkwkLand/comments/', feed()]]);
  const [card] = await buildCards(POST, { fetchImpl: impl });

  assert.ok(card);
  assert.match(calls[0]!.url, /\/lagu_macam_apa_ini\/\.rss$/, 'the post feed, not the page');
  assert.match(calls[0]!.headers['user-agent']!, /^cleanlink\//, 'the bare Mozilla/5.0 gets 403');
  assert.equal(card.embeds[0]!.title, 'LAGU MACAM APA INI?!');
  assert.equal(card.embeds[0]!.author!.name, 'r/WkwkwkLand · u/Faketaxidriver\\_069');
  assert.equal(card.embeds[0]!.footer!.text, 'Reddit');
  assert.equal(card.embeds[0]!.url, POST);
});

test('Reddit card shows an uploaded picture at its own size', async () => {
  // A picture post links i.redd.it; the feed's preview is a 640 px proxy of it.
  const picture = 'https://i.redd.it/wxyz1234.jpeg';
  const { impl } = fakeFetch([['https://www.reddit.com/r/WkwkwkLand/comments/', feed({ media: picture })]]);
  const [card] = await buildCards(POST, { fetchImpl: impl });

  assert.equal(card!.embeds[0]!.image!.url, picture);
});

test('Reddit card keeps the preview picture when the post only has one', async () => {
  const { impl } = fakeFetch([['https://www.reddit.com/r/WkwkwkLand/comments/', feed()]]);
  const [card] = await buildCards(POST, { fetchImpl: impl });

  assert.equal(card!.embeds[0]!.image!.url, 'https://external-preview.redd.it/abc.png?width=640&s=1');
});

test('Reddit card is skipped when the feed has no entry', async () => {
  // What Reddit answers an anonymous reader past its rate limit: 200 and an
  // empty body, or a 429.
  const { impl } = fakeFetch([['https://www.reddit.com/r/WkwkwkLand/comments/', '<feed></feed>']]);
  assert.deepEqual(await buildCards(POST, { fetchImpl: impl }), []);
});

test('Reddit card shows every gallery picture at its uploaded size', async () => {
  const { impl, calls } = fakeFetch([
    ['https://www.reddit.com/r/WkwkwkLand/comments/', feed({ gallery: '1xqvap5' })],
    ['https://embed.reddit.com/r/WkwkwkLand/comments/', galleryPage(['aaa1', 'bbb2', 'ccc3'])],
  ]);
  const [card] = await buildCards(POST, { fetchImpl: impl });

  // The post links no file, so without the gallery the card would fall back to
  // the feed's 640 px preview and show one picture.
  assert.equal(card!.embeds.length, 3);
  assert.deepEqual(
    card!.embeds.map((embed) => embed.image?.url),
    ['https://i.redd.it/aaa1.png', 'https://i.redd.it/bbb2.png', 'https://i.redd.it/ccc3.png'],
    'gallery order, and the media id of the preview names the original',
  );
  const embedCall = calls.find((call) => call.url.startsWith('https://embed.reddit.com/'));
  assert.ok(embedCall, 'the embed view is the only page that renders a gallery');
  assert.match(embedCall.headers['user-agent']!, /^cleanlink\//);
});

test('Reddit card falls back to the feed picture when the gallery page fails', async () => {
  const { impl } = fakeFetch([['https://www.reddit.com/r/WkwkwkLand/comments/', feed({ gallery: '1xqvap5' })]]);
  const [card] = await buildCards(POST, { fetchImpl: impl });

  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.image!.url, 'https://external-preview.redd.it/abc.png?width=640&s=1');
});
