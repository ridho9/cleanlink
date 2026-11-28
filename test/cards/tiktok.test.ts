import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import type { TestContext } from 'node:test';

import { buildCards } from '../../src/cards/index.ts';
import { cleanMessage } from '../../src/clean.ts';
import { sendReply } from '../../src/reply.ts';
import { fakeFetch, fixture } from '../../test-support/harness.ts';

const TIKWM = fixture('tikwm-video.json');
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const LINK = 'https://www.tiktok.com/@tiktok/video/7666123874932722974';
const TIKWM_API = 'https://www.tikwm.com/api/';
const METADATA = { channel: 'Example Creator', uploader: 'tiktok', title: 'Example title', thumbnail: 'https://example.com/cover.jpg' };

// Never run the real extractor, even in tests that do not expect a fallback.
let stub: string;
const path = process.env.PATH;
before(async () => {
  stub = await mkdtemp(join(tmpdir(), 'cleanlink-test-'));
  process.env.PATH = stub;
});
after(async () => {
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  await rm(stub, { recursive: true, force: true });
});

async function stubYtDlp(t: TestContext, transfer: string) {
  const argsFile = join(stub, 'args.json');
  const executable = join(stub, 'yt-dlp');
  await writeFile(executable, `#!${process.execPath}
const { writeFileSync, truncateSync } = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('-o') + 1];
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const metadata = () => writeFileSync(args[args.indexOf('--print-to-file') + 2], ${JSON.stringify(JSON.stringify(METADATA))});
const video = () => writeFileSync(file, Buffer.from('${MP4_BYTES.toString('hex')}', 'hex'));
${transfer}
`, { mode: 0o755 });
  t.after(async () => {
    await rm(executable, { force: true });
    await rm(argsFile, { force: true });
  });
  return argsFile;
}

function tikwmUnavailable() {
  return fakeFetch([[TIKWM_API, new Response(null, { status: 502 })]]).impl;
}

async function assertDownloadCleaned(argsFile: string) {
  const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
  const output = args[args.indexOf('-o') + 1]!;
  await assert.rejects(access(dirname(output)), { code: 'ENOENT' });
}

test('TikTok uses a successful tikwm card without starting yt-dlp', async (t) => {
  const argsFile = await stubYtDlp(t, 'metadata(); video();');
  // No `play` route: the media fetch fails, so the cover stays.
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
  assert.equal(card.embeds[0]!.author!.name, 'TikTok (@tiktok)');
  assert.equal(card.embeds[0]!.author!.icon_url, TIKWM.data.author.avatar);
  assert.equal(
    card.embeds[0]!.description,
    `${TIKWM.data.title}\n\n▶ ${TIKWM.data.play_count.toLocaleString('en-US')} · ` +
      `❤️ ${TIKWM.data.digg_count.toLocaleString('en-US')} · ` +
      `💬 ${TIKWM.data.comment_count.toLocaleString('en-US')}`,
  );
  assert.equal(card.embeds[0]!.fields, undefined, 'no field per number');
  assert.equal(card.embeds[0]!.footer!.text, 'TikTok');
  assert.equal(card.embeds[0]!.timestamp, new Date(TIKWM.data.create_time * 1000).toISOString());
  await assert.rejects(access(argsFile), { code: 'ENOENT' });
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
  assert.match(calls[0]!.url, /url=https%3A%2F%2Fwww.tiktok.com%2F%40tiktok%2Fvideo%2F7666123874932722974/);
});

test('TikTok attaches the fallback MP4 when tikwm returns HTTP 502', async (t) => {
  const argsFile = await stubYtDlp(t, 'metadata(); video();');
  const [card] = await buildCards(LINK, { fetchImpl: tikwmUnavailable() });

  assert.equal(card?.video, 'attached');
  assert.deepEqual(card.files, [{ attachment: MP4_BYTES, name: 'video.mp4' }]);
  assert.equal(card.embeds[0]?.description, METADATA.title);
  assert.equal(card.embeds[0]?.image, undefined);
  await assertDownloadCleaned(argsFile);
});

test('TikTok keeps fallback metadata when tikwm times out and the video transfer fails', async (t) => {
  const argsFile = await stubYtDlp(t, 'metadata(); video(); process.exit(1);');
  const tikwm = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 12_000 ? tikwm.signal : timeout(ms));
  let requestAborted = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    tikwm.abort(new DOMException('timed out', 'TimeoutError'));
    requestAborted = init?.signal?.aborted === true;
    throw tikwm.signal.reason;
  };
  const [card] = await buildCards(LINK, { fetchImpl });

  assert.ok(requestAborted, 'the request uses the tikwm deadline');
  assert.ok(card);
  assert.deepEqual(card.files, []);
  assert.equal(card.embeds[0]?.author?.name, 'Example Creator (@tiktok)');
  assert.equal(card.embeds[0]?.description, METADATA.title);
  assert.equal(card.embeds[0]?.image?.url, METADATA.thumbnail);
  await assertDownloadCleaned(argsFile);
});

test('TikTok keeps the cover when an extractor output exceeds the upload cap', async (t) => {
  const argsFile = await stubYtDlp(t, 'metadata(); video(); truncateSync(file, 9_500_001);');
  const [card] = await buildCards(LINK, { fetchImpl: tikwmUnavailable() });

  assert.ok(card);
  assert.deepEqual(card.files, []);
  assert.equal(card.embeds[0]?.image?.url, METADATA.thumbnail);
  await assertDownloadCleaned(argsFile);
});

test('TikTok replies with the cleaned link when both sources fail', async (t) => {
  const argsFile = await stubYtDlp(t, 'process.exit(1);');
  const { impl } = fakeFetch([[TIKWM_API, { code: -1, msg: 'Url parsing is failed' }]]);
  const input = `${LINK}?_t=abc`;
  const lines = await cleanMessage(input, { fetchImpl: impl });
  const cards = await buildCards(input, { cleaned: lines, fetchImpl: impl });
  const replies: unknown[] = [];
  await sendReply({
    reply: async (payload) => { replies.push(payload); },
    channel: { send: async () => assert.fail('no follow-up expected') },
  }, { lines, cards });

  assert.deepEqual(replies, [{ content: LINK, allowedMentions: { parse: [] } }]);
  await assertDownloadCleaned(argsFile);
});

test('TikTok returns no card if yt-dlp is not installed', async () => {
  assert.deepEqual(await buildCards(LINK, { fetchImpl: tikwmUnavailable() }), []);
});

test('the total TikTok deadline stops a running extractor and removes the partial file', { timeout: 5_000 }, async (t) => {
  // The marker drives the abort. The wait limit only prevents a leaked test process on failure.
  const argsFile = await stubYtDlp(t, `video(); writeFileSync(${JSON.stringify(join(stub, 'started'))}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000);`);
  const budget = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 18_000 ? budget.signal : timeout(ms));
  const watcher = watch(stub, (_event, name) => {
    if (name === 'started') budget.abort(new DOMException('timed out', 'TimeoutError'));
  });
  try {
    assert.deepEqual(await buildCards(LINK, { fetchImpl: tikwmUnavailable() }), []);
    assert.ok(budget.signal.aborted);
    await assertDownloadCleaned(argsFile);
  } finally {
    watcher.close();
    budget.abort();
  }
});

test('the total TikTok deadline prevents starting yt-dlp after tikwm', async (t) => {
  const argsFile = await stubYtDlp(t, 'metadata(); video();');
  const budget = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 18_000 ? budget.signal : timeout(ms));
  let requestAborted = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    budget.abort(new DOMException('timed out', 'TimeoutError'));
    requestAborted = init?.signal?.aborted === true;
    throw budget.signal.reason;
  };

  assert.deepEqual(await buildCards(LINK, { fetchImpl }), []);
  assert.ok(requestAborted, 'the request also uses the total deadline');
  await assert.rejects(access(argsFile), { code: 'ENOENT' });
});

test('a tikwm answer slower than the usual 6 s still makes a card', async (t) => {
  // Pretend that deadlines shorter than a 10 s tikwm answer have expired.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms < 10_000
    ? AbortSignal.abort(new DOMException('timed out', 'TimeoutError')) : timeout(ms));
  const { impl: base } = fakeFetch([[TIKWM_API, TIKWM]]);
  const impl: typeof fetch = async (url, init) => {
    if (String(url).startsWith(TIKWM_API)) init?.signal?.throwIfAborted();
    return base(url, init);
  };

  const [card] = await buildCards('https://www.tiktok.com/@tiktok/video/7666123874932722974', { fetchImpl: impl });

  assert.ok(card, 'tikwm answered inside its deadline');
  assert.equal(card.embeds[0]!.author!.name, 'TikTok (@tiktok)');
});

test('the TikTok video is attached, and the cover is not repeated', async () => {
  const { impl } = fakeFetch([
    ['https://www.tikwm.com/api/', TIKWM],
    [TIKWM.data.play, new Response(MP4_BYTES, { status: 200 })],
  ]);
  const [card] = await buildCards('https://www.tiktok.com/@tiktok/video/7666123874932722974', {
    fetchImpl: impl,
  });

  assert.equal(card!.files.length, 1);
  assert.deepEqual(card!.files[0]!.attachment, MP4_BYTES);
  assert.equal(card!.embeds[0]!.image, undefined, 'the player brings its own frame');
  assert.equal(card!.followUp, undefined);
});

test('a TikTok video over the budget becomes a follow-up, not a dead cover', async () => {
  const { impl } = fakeFetch([
    ['https://www.tikwm.com/api/', TIKWM],
    [TIKWM.data.play, new Response(MP4_BYTES, {
      status: 200,
      headers: { 'content-length': String(12 * 1024 * 1024) },
    })],
  ]);
  const [card] = await buildCards('https://www.tiktok.com/@tiktok/video/7666123874932722974', {
    fetchImpl: impl,
  });

  assert.deepEqual(card!.files, []);
  assert.equal(card!.followUp, TIKWM.data.play);
  assert.equal(card!.embeds[0]!.image, undefined);
});
