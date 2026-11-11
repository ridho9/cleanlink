import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { handleMessage } from '../src/handler.ts';
import { originalDeleted } from '../src/replies.ts';

// A YouTube link with a share token: cleaned without a network request, and
// no card site owns it, so the path runs offline.
const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc';

interface Hooks {
  /** Runs inside sendTyping(): the bot is working on the message. */
  onTyping?: (id: string) => Promise<void>;
  /** Runs inside reply(), before it answers. */
  onReply?: (id: string) => Promise<void>;
  /** reply() throws this instead of answering. */
  replyError?: unknown;
}

let next = 0;

/** A guild message with Manage Messages granted, recording what the bot did. */
function guildMessage(hooks: Hooks = {}) {
  const id = `handler-${(next += 1)}`;
  const events: string[] = [];
  const user = { id: 'bot' };
  const message = {
    id,
    content: LINK,
    author: { bot: false, tag: 'user#0001' },
    guild: { name: 'test' },
    channel: {
      id: 'c1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
      sendTyping: async () => {
        events.push('typing');
        await hooks.onTyping?.(id);
      },
    },
    client: { user },
    suppressEmbeds: async (on: boolean) => {
      events.push(on ? 'hide' : 'restore');
    },
    // Nothing may react to the message any more: a reaction notifies its
    // author, which is why the indicator replaced it.
    react: async () => {
      events.push('react');
      return { users: { remove: async () => { events.push('unreact'); } } };
    },
    reply: async () => {
      await hooks.onReply?.(id);
      if (hooks.replyError) throw hooks.replyError;
      events.push('reply');
      return { delete: async () => { events.push('reply deleted'); } };
    },
  };
  return { message: message as unknown as OmitPartialGroupDMChannel<Message>, events };
}

/** Run the handler and return its `[msg]` record. */
async function run(message: OmitPartialGroupDMChannel<Message>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await handleMessage(message);
  } finally {
    console.log = original;
  }
  const line = lines.find((l) => l.startsWith('[msg] '));
  return JSON.parse(line!.slice(6));
}

test('a reply replaces the hidden preview, and hides it again after', async () => {
  const { message, events } = guildMessage();
  const record = await run(message);

  assert.equal(record.reply, 'sent');
  // The second hide catches a preview Discord added after the first one.
  assert.deepEqual(events, ['hide', 'typing', 'reply', 'hide']);
});

test('deleted before the reply: no reply, and no preview to restore', async () => {
  const { message, events } = guildMessage({ onTyping: (id) => originalDeleted(id) });
  const record = await run(message);

  assert.equal(record.reply, 'deleted');
  assert.deepEqual(events, ['hide', 'typing']);
});

test('deleted while the reply is in flight: the reply is removed', async () => {
  const { message, events } = guildMessage({ onReply: (id) => originalDeleted(id) });
  const record = await run(message);

  assert.equal(record.reply, 'withdrawn');
  assert.deepEqual(events, ['hide', 'typing', 'reply', 'reply deleted']);
});

test('a refused reply hands the preview back', async () => {
  const refusal = Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
  const { message, events } = guildMessage({ replyError: refusal });
  const record = await run(message);

  assert.equal(record.reply, 'refused');
  assert.deepEqual(events, ['hide', 'typing', 'restore']);
});

test('an unexpected error hands the preview back and is recorded', async () => {
  const { message, events } = guildMessage({ replyError: new Error('socket hang up') });
  const record = await run(message);

  assert.equal(record.reply, 'error');
  assert.deepEqual(events, ['hide', 'typing', 'restore']);
});
