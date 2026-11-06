import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { buildMangadexCard } from '../../src/cards/mangadex.ts';
import { fakeFetch, fixture, IMAGE_BYTES, imageResponse } from '../../test-support/harness.ts';

const MANGA = fixture('mangadex-manga.json');
const STATS = fixture('mangadex-statistics.json');
const ID = 'c4ca02fb-8378-433b-8049-fbbea5d25cba';
const URL = `https://mangadex.org/title/${ID}/haimiya-senpai-wa-kowakute-kawaii`;
const COVER = `https://uploads.mangadex.org/covers/${ID}/7ab29404-0ebd-4862-ad4e-e4ea1ffe231f.jpg.512.jpg`;

function rated(contentRating: string) {
  const copy = structuredClone(MANGA);
  copy.data.attributes.contentRating = contentRating;
  return copy;
}

const routes = (manga: unknown = MANGA): [string, unknown][] => [
  [`https://api.mangadex.org/manga/${ID}`, manga],
  [`https://api.mangadex.org/statistics/manga/${ID}`, STATS],
  ['https://uploads.mangadex.org/', imageResponse()],
];

test('MangaDex card shows cover, title, author, status, rating and follows', async () => {
  const { impl, calls } = fakeFetch(routes());
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card);
  const embed = card.embeds[0]!;
  assert.equal(embed.title, 'Haimiya-senpai wa Kowakute Kawaii');
  assert.equal(embed.url, `https://mangadex.org/title/${ID}`);
  // The author is also the artist: one name, not two.
  assert.equal(embed.author!.name, 'Kamiyama Sumu');
  // The synopsis first, cut at a space before 350 characters, then the stats.
  assert.equal(
    embed.description,
    'At my high school, Haimiya-senpai is feared by all and considered too scary. This is apparently due to her ' +
      'intimidating appearance and blunt way of speaking... and those sparkling piercings! The long, gray wolf-cut ' +
      'hair! Even her Kansai accent is intimidating!!!\nBut for some reason, this scary senpai treats me kindly...?\n' +
      'As "scary" turns into…\n\nRomance · Comedy · Drama · School Life · Slice of Life\n\nOngoing · Safe\n' +
      '⭐ 9.46 · 🔖 133,886',
  );
  assert.equal(embed.image!.url, COVER);
  assert.equal(card.files.length, 0);
  // A browser user agent is sent to the proof-of-work challenge, API included.
  for (const call of calls) assert.ok(!call.headers['user-agent']!.startsWith('Mozilla'), call.url);
});

test('MangaDex cover of an erotica or pornographic title is attached spoilered', async () => {
  for (const rating of ['erotica', 'pornographic']) {
    const { impl, calls } = fakeFetch(routes(rated(rating)));
    const [card] = await buildCards(URL, { fetchImpl: impl });

    assert.equal(card!.embeds[0]!.image, undefined, `${rating}: Discord cannot spoiler an embed image`);
    assert.equal(card!.files.length, 1);
    assert.equal(card!.files[0]!.name, 'SPOILER_cover.jpg');
    assert.deepEqual(card!.files[0]!.attachment, IMAGE_BYTES);
    assert.equal(calls.at(-1)!.url, COVER);
  }
});

test('a spoilered MangaDex cover is dropped, never shown, when the file budget is spent', async () => {
  const { impl } = fakeFetch(routes(rated('pornographic')));
  const card = await buildMangadexCard(
    { match: [`/title/${ID}`, ID], href: URL },
    { fetchImpl: impl, budget: { files: 0, bytes: 8_000_000 } },
  );

  assert.ok(card);
  assert.equal(card.embeds[0]!.image, undefined);
  assert.equal(card.files.length, 0);
});

test('MangaDex card keeps the text when the statistics request fails', async () => {
  const { impl } = fakeFetch([[`https://api.mangadex.org/manga/${ID}`, MANGA]]);
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card!.embeds[0]!.description!.endsWith('\n\nOngoing · Safe'));
});

test('MangaDex synopsis stops at the rule before the links, and keeps its Markdown', async () => {
  const manga = structuredClone(MANGA);
  manga.data.attributes.description = {
    ja: '日本語',
    en: 'A **scary** senpai.\n\n---\n\n**Links:**\n- [Official](https://example.com)',
  };
  const { impl } = fakeFetch(routes(manga));
  const [card] = await buildCards(URL, { fetchImpl: impl });

  assert.ok(card!.embeds[0]!.description!.startsWith('A **scary** senpai.\n\nRomance'));
  assert.ok(!card!.embeds[0]!.description!.includes('Official'), 'the links after the rule are dropped');
});

test('MangaDex tags are genres and themes only, at most eight', async () => {
  const manga = structuredClone(MANGA);
  const tag = (group: string, name: string) => ({ attributes: { group, name: { en: name } } });
  manga.data.attributes.tags = [
    tag('format', 'Oneshot'),
    ...['Action', 'Comedy', 'Drama', 'Horror', 'Romance', 'Sports', 'Thriller', 'Tragedy', 'Mystery', 'Mecha'].map(
      (name) => tag('genre', name),
    ),
    tag('theme', 'School Life'),
    tag('content', 'Gore'),
  ];
  const { impl } = fakeFetch(routes(manga));
  const [card] = await buildCards(URL, { fetchImpl: impl });

  const tags = card!.embeds[0]!.description!.split('\n\n')[1]!;
  assert.equal(tags, 'Action · Comedy · Drama · Horror · Romance · Sports · Thriller · Tragedy');
});

test('MangaDex card is skipped for a title that does not exist', async () => {
  const { impl } = fakeFetch([
    ['https://api.mangadex.org/manga/', new Response('{"result":"error","errors":[]}', { status: 404 })],
  ]);
  assert.deepEqual(await buildCards(URL, { fetchImpl: impl }), []);
});

test('MangaDex card matches a title with or without a slug, and not a chapter', async () => {
  const { impl } = fakeFetch(routes());
  for (const url of [`https://mangadex.org/title/${ID}`, `https://mangadex.org/title/${ID}/`, URL]) {
    assert.equal((await buildCards(url, { fetchImpl: impl })).length, 1, url);
  }
  assert.deepEqual(await buildCards(`https://mangadex.org/chapter/${ID}`, { fetchImpl: impl }), []);
});
