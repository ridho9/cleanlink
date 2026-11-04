import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards } from '../../src/cards/index.js';
import { fakeFetch, fixture } from '../../test-support/harness.js';

const TIKWM = fixture('tikwm-video.json');

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
