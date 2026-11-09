import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { fakeFetch } from '../../test-support/harness.ts';

const POST = 'https://www.reddit.com/r/WkwkwkLand/comments/1xreva8/lagu_macam_apa_ini/';

/** The shape of a post's Atom feed, trimmed to what the builder reads. */
function feed({ title = 'LAGU MACAM APA INI?!', media = null as string | null } = {}) {
  // Reddit escapes the entry's HTML twice over: `&quot;` for every quote.
  const anchor = (href: string, text: string) => `&lt;a href=&quot;${href}&quot;&gt;${text}&lt;/a&gt;`;
  const link = media ? anchor(media, '[link]') : '';
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<entry>
<title>${title}</title>
<author><name>/u/Faketaxidriver_069</name><uri>https://www.reddit.com/user/Faketaxidriver_069</uri></author>
<content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;${anchor(POST, '&lt;img src=&quot;https://external-preview.redd.it/abc.png?width=640&amp;amp;s=1&quot; /&gt;')}&lt;/td&gt;&lt;td&gt; submitted by ${anchor('https://www.reddit.com/user/Faketaxidriver_069', '/u/Faketaxidriver_069')} &lt;br/&gt;${link}&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
<media:thumbnail url="https://external-preview.redd.it/abc.png?width=640&amp;s=1" />
</entry>
</feed>`;
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
