import assert from 'node:assert/strict';
import test from 'node:test';

import { fitLines, hasContent, sendReply, withoutAttachmentImages } from '../src/reply.js';

/** A message stand-in that records payloads and can reject the first N of them. */
function fakeMessage({ reject = 0 } = {}) {
  const sent = [];
  return {
    sent,
    reply: async (payload) => {
      if (sent.length < reject) {
        sent.push(payload);
        throw new Error('Missing Permissions');
      }
      sent.push(payload);
      return {};
    },
  };
}

const lines = [
  { from: 'https://x.com/a/status/1?s=20', to: 'https://x.com/a/status/1' },
  { from: 'https://youtu.be/abc?si=1', to: 'https://youtu.be/abc' },
];

const card = {
  from: 'https://x.com/a/status/1?s=20',
  url: 'https://x.com/a/status/1',
  embeds: [{ url: 'https://x.com/a/status/1', description: 'text' }],
  files: [],
};

test('a carded link is bracketed and the plain link is not repeated', async () => {
  const message = fakeMessage();
  await sendReply(message, { lines, cards: [card] });

  assert.equal(message.sent.length, 1);
  assert.equal(message.sent[0].content, '<https://x.com/a/status/1>\nhttps://youtu.be/abc');
  assert.equal(message.sent[0].embeds.length, 1);
});

test('extra lines a card asks for land after the bracketed link', async () => {
  const message = fakeMessage();
  await sendReply(message, {
    lines: [],
    cards: [{
      from: 'https://www.instagram.com/reel/X/',
      url: 'https://www.instagram.com/reel/X/',
      embeds: [{ title: 'x' }],
      files: [],
      extraLines: ['https://vxinstagram.com/reel/X/'],
    }],
  });

  assert.equal(
    message.sent[0].content,
    '<https://www.instagram.com/reel/X/> https://vxinstagram.com/reel/X/',
    'the extra link shares the card line',
  );
});

test('a follow-up line is sent as its own message after the card', async () => {
  const message = fakeMessage();
  await sendReply(message, {
    lines: [],
    cards: [{
      from: 'https://www.instagram.com/reel/X/',
      url: 'https://www.instagram.com/reel/X/',
      embeds: [{ title: 'reel' }],
      files: [],
      followUps: ['https://cdn.example/video.mp4'],
    }],
  });

  assert.equal(message.sent.length, 2);
  assert.equal(message.sent[0].embeds.length, 1);
  assert.equal(message.sent[1].content, 'https://cdn.example/video.mp4');
  assert.equal(message.sent[1].embeds, undefined, 'a bare URL unfurls into the player');
});

test('a plain clean reply carries no embeds', async () => {
  const message = fakeMessage();
  await sendReply(message, { lines, cards: [] });

  assert.equal(message.sent[0].content, 'https://x.com/a/status/1\nhttps://youtu.be/abc');
  assert.equal(message.sent[0].embeds, undefined);
  assert.equal(message.sent[0].files, undefined);
});

test('a rejected attachment falls back to the embed without its image', async () => {
  const message = fakeMessage({ reject: 1 });
  const withFile = {
    from: 'https://www.pixiv.net/artworks/1',
    url: 'https://www.pixiv.net/artworks/1',
    embeds: [
      { url: 'https://www.pixiv.net/artworks/1', title: 'work', image: { url: 'attachment://p0.jpg' } },
      { url: 'https://www.pixiv.net/artworks/1', image: { url: 'attachment://p1.jpg' } },
    ],
    files: [{ attachment: Buffer.from([1]), name: 'p0.jpg' }],
  };

  await sendReply(message, { lines: [], cards: [withFile] });

  assert.equal(message.sent.length, 2);
  assert.equal(message.sent[0].files.length, 1);
  // The first embed keeps its title; the page-only embed had nothing left.
  assert.equal(message.sent[1].embeds.length, 1);
  assert.equal(message.sent[1].embeds[0].title, 'work');
  assert.equal(message.sent[1].embeds[0].image, undefined);
});

test('a rejected embed falls back to the plain links', async () => {
  const message = fakeMessage({ reject: 1 });
  await sendReply(message, { lines, cards: [card] });

  assert.equal(message.sent.length, 2);
  assert.equal(message.sent[1].content, 'https://x.com/a/status/1\nhttps://youtu.be/abc');
  assert.equal(message.sent[1].embeds, undefined);
});

test('a final failure is thrown, not swallowed', async () => {
  const message = fakeMessage({ reject: 9 });
  await assert.rejects(() => sendReply(message, { lines, cards: [card] }), /Missing Permissions/);
});

test('fitLines keeps whole lines inside the limit', () => {
  assert.deepEqual(fitLines(['aa', 'bb'], 2000), ['aa', 'bb']);
  // 5 + 1 + 5 fits exactly; the third line does not.
  assert.deepEqual(fitLines(['aaaaa', 'bbbbb', 'cc'], 11), ['aaaaa', 'bbbbb']);
  assert.deepEqual(fitLines(['aaaaaaaaaa'], 5), []);
});

test('hasContent tells a real embed from an image holder', () => {
  assert.equal(hasContent({ title: 'x' }), true);
  assert.equal(hasContent({ fields: [{ name: 'a', value: 'b' }] }), true);
  assert.equal(hasContent({ image: { url: 'attachment://p0.jpg' } }), true);
  assert.equal(hasContent({ color: 0xffffff }), false);
});

test('withoutAttachmentImages only touches attachment images', () => {
  assert.equal(withoutAttachmentImages({ image: { url: 'https://x/y.jpg' } }).image.url, 'https://x/y.jpg');
  const stripped = withoutAttachmentImages({ image: { url: 'attachment://p0.jpg' } });
  assert.equal(stripped.image, undefined);
});
