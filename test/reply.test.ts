import assert from 'node:assert/strict';
import test from 'node:test';

import { fitLines, hasContent, sendReply, withoutAttachmentImages } from '../src/reply.ts';
import type { ReplyTarget } from '../src/reply.ts';
import type { CardEmbed, CardFile } from '../src/cards/shared.ts';

type RecordedPayload = { content?: string; embeds?: CardEmbed[]; files?: CardFile[] };

/** A message stand-in that records payloads and can reject the first N of them. */
function fakeMessage({ reject = 0, failFollowUp = false } = {}) {
  const sent: RecordedPayload[] = [];
  const followUps: RecordedPayload[] = [];
  return {
    sent,
    followUps,
    reply: async (payload: Parameters<ReplyTarget<unknown>['reply']>[0]) => {
      if (sent.length < reject) {
        sent.push(payload as RecordedPayload);
        throw new Error('Missing Permissions');
      }
      sent.push(payload as RecordedPayload);
      return {};
    },
    channel: {
      send: async (payload: Parameters<ReplyTarget<unknown>['channel']['send']>[0]) => {
        followUps.push(payload as RecordedPayload);
        if (failFollowUp) throw new Error('Missing Access');
        return {};
      },
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
  assert.equal(message.sent[0].embeds!.length, 1);
});

test('media that could not be attached goes out as its own message', async () => {
  const message = fakeMessage();
  await sendReply(message, {
    lines: [],
    cards: [{
      from: 'https://x.com/a/status/1',
      url: 'https://x.com/a/status/1',
      embeds: [{ title: 'x' }],
      files: [],
      video: 'follow_up',
      followUp: 'https://video.twimg.com/big.mp4',
    }],
  });

  assert.equal(message.sent[0].content, '<https://x.com/a/status/1>', 'the card line stays clean');
  assert.deepEqual(message.followUps, [
    // Masked: the signed URL is long, and the label unfurls the same player.
    { content: '[▶ Play video](https://video.twimg.com/big.mp4)', allowedMentions: { parse: [] } },
  ]);
});

test('every posted message is reported, so it can be deleted with its original', async () => {
  const message = fakeMessage({ reject: 1 });
  const reported = [];
  await sendReply(message, {
    lines: [],
    cards: [{ ...card, files: [{ attachment: Buffer.alloc(1), name: 'p0.jpg' }], video: 'follow_up', followUp: 'https://video.twimg.com/v.mp4' }],
  }, { onSent: async (sent) => reported.push(sent) });

  // The first attempt was rejected and posted nothing; the fallback reply and
  // the follow-up were posted, and only they are reported.
  assert.equal(message.sent.length, 2);
  assert.equal(reported.length, 2);
});

test('at most two follow-ups, and a failed one never breaks the reply', async () => {
  const message = fakeMessage({ failFollowUp: true });
  const many = Array.from({ length: 4 }, (_, i) => ({
    from: `https://x.com/a/status/${i}`,
    url: `https://x.com/a/status/${i}`,
    embeds: [{ title: `x${i}` }],
    files: [],
    video: 'follow_up' as const,
    followUp: `https://video.twimg.com/${i}.mp4`,
  }));

  await sendReply(message, { lines: [], cards: many });

  assert.equal(message.followUps.length, 2, 'capped');
  assert.equal(message.sent.length, 1, 'the reply itself still went out');
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
  assert.equal(message.sent[0].files!.length, 1);
  // The first embed keeps its title; the page-only embed had nothing left.
  assert.equal(message.sent[1].embeds!.length, 1);
  assert.equal(message.sent[1].embeds![0].title, 'work');
  assert.equal(message.sent[1].embeds![0].image, undefined);
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
  assert.equal(withoutAttachmentImages({ image: { url: 'https://x/y.jpg' } }).image!.url, 'https://x/y.jpg');
  const stripped = withoutAttachmentImages({ image: { url: 'attachment://p0.jpg' } });
  assert.equal(stripped.image, undefined);
});

test('a card that hands the link over sends it bare, so it unfurls', async () => {
  const sent: RecordedPayload[] = [];
  const message = {
    reply: async (payload: Parameters<ReplyTarget<unknown>['reply']>[0]) => {
      sent.push(payload as RecordedPayload);
      return {};
    },
    channel: { send: async (payload: Parameters<ReplyTarget<unknown>['channel']['send']>[0]) => (sent.push(payload as RecordedPayload), payload) },
    react: async () => ({}),
  };

  await sendReply(message, {
    lines: [{ from: 'https://www.facebook.com/reel/1', to: 'https://www.facebook.com/reel/1' }],
    cards: [
      {
        from: 'https://www.facebook.com/reel/1',
        url: 'https://www.facebed.com/reel/1/',
        embeds: [],
        files: [],
        video: 'unfurl',
      },
    ],
  });

  assert.equal(sent[0].content, 'https://www.facebed.com/reel/1/');
  assert.equal(sent[0].embeds, undefined, 'the link itself is the preview');
});
