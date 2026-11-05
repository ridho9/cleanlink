import assert from 'node:assert/strict';
import test from 'node:test';

import { finishTrace, mark, markReply, note, runTraced, startTrace, withUrl } from '../src/trace.js';

/** Run `fn` and return the `[msg]` record it wrote. */
async function record(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const trace = startTrace({ id: 'm1', where: 'dm' });
    await runTraced(trace, () => fn(trace));
    finishTrace(trace);
  } finally {
    console.log = original;
  }
  const line = lines.find((l) => l.startsWith('[msg] '));
  return { record: JSON.parse(line.slice(6)), lines };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('notes and marks from URLs handled at the same time stay with their URL', async () => {
  const { record: r, lines } = await record(async () => {
    note('message-level');
    // cleanMessage resolves every URL in parallel: their awaits interleave.
    await Promise.all(['https://a.example/1', 'https://b.example/2'].map((url) => withUrl(url, async () => {
      note(`start ${url}`);
      await tick();
      mark('clean', `${url}#clean`);
      note(`end ${url}`);
    })));
  });

  assert.deepEqual(r.notes, ['message-level']);
  assert.deepEqual(r.urls, [
    { in: 'https://a.example/1', clean: 'https://a.example/1#clean', notes: ['start https://a.example/1', 'end https://a.example/1'] },
    { in: 'https://b.example/2', clean: 'https://b.example/2#clean', notes: ['start https://b.example/2', 'end https://b.example/2'] },
  ]);
  assert.ok(lines.includes('start https://a.example/1'), 'every note still goes to the log on its own');
});

test('a URL visited twice (clean, then card) is one entry with both outcomes', async () => {
  const { record: r } = await record(async () => {
    await withUrl('https://x.com/a/status/1', () => mark('clean', 'unchanged'));
    await withUrl('https://x.com/a/status/1', () => { mark('card', 'x'); mark('media', 'video'); });
  });

  assert.deepEqual(r.urls, [{ in: 'https://x.com/a/status/1', clean: 'unchanged', card: 'x', media: 'video' }]);
});

test('the record names how the message ended, and defaults to nothing', async () => {
  const { record: sent } = await record((trace) => markReply(trace, 'sent'));
  const { record: silent } = await record(() => {});

  assert.equal(sent.reply, 'sent');
  assert.equal(silent.reply, 'nothing');
  assert.equal(silent.notes, undefined, 'no empty notes field');
});

test('outside a traced message, note only logs and mark does nothing', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    note('plain');
    mark('clean', 'x');
    assert.equal(await withUrl('https://a.example/', async () => 42), 42);
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, ['plain']);
});
