import assert from 'node:assert/strict';
import test from 'node:test';

import { originalDeleted, track } from '../src/replies.ts';

function botMessage(name: string, log: string[], { fails = false } = {}) {
  return {
    delete: async () => {
      if (fails) throw new Error('Unknown Message');
      log.push(name);
    },
  };
}

test('deleting the original deletes the reply and its follow-up', async () => {
  const log: string[] = [];
  const replies = track('m1');
  await replies.add(botMessage('reply', log));
  await replies.add(botMessage('follow-up', log));

  await originalDeleted('m1');

  assert.deepEqual(log.sort(), ['follow-up', 'reply']);
  assert.equal(replies.deleted(), true);
});

test('a reply that lands after the original was deleted is removed at once', async () => {
  const log: string[] = [];
  const replies = track('m2');
  await originalDeleted('m2');
  assert.equal(replies.deleted(), true, 'the handler can skip the reply');

  await replies.add(botMessage('late reply', log));

  assert.deepEqual(log, ['late reply']);
});

test('only the deleted message loses its replies', async () => {
  const log: string[] = [];
  const kept = track('m3');
  await kept.add(botMessage('kept', log));
  track('m4');

  await originalDeleted('m4');
  await originalDeleted('never-tracked');

  assert.deepEqual(log, []);
  assert.equal(kept.deleted(), false);
});

test('a reply that is already gone does not stop the others', async () => {
  const log: string[] = [];
  const replies = track('m5');
  await replies.add(botMessage('gone', log, { fails: true }));
  await replies.add(botMessage('reply', log));

  await originalDeleted('m5');

  assert.deepEqual(log, ['reply']);
});

test('a message still being handled is not evicted by 1000 newer ones', async () => {
  const log: string[] = [];
  const slow = track('slow');
  const old = track('old');
  old.close();
  await old.add(botMessage('old reply', log));

  for (let i = 0; i < 1000; i += 1) track(`busy-${i}`).close();

  // The slow handler replies only now, and then the user deletes the message.
  await slow.add(botMessage('slow reply', log));
  await originalDeleted('slow');
  await originalDeleted('old');

  assert.deepEqual(log, ['slow reply'], 'the finished, older entry was the one evicted');
});
