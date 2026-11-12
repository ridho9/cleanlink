import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadMedia, readPage } from '../../src/cards/shared.ts';

/** A response whose headers arrive, then whose body dies mid-file. */
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('socket hang up'));
      },
    }),
    { status: 200, headers: { 'content-type': 'video/mp4' } },
  );

test('a body that dies mid-file costs the media candidate, not the caller', async () => {
  const impl = (async () => brokenBody()) as unknown as typeof fetch;

  // The deadline covers the body read too, so a reset there throws out of the
  // reader. That must not reach the builder, which would drop the card's text
  // and stills as well.
  const result = await downloadMedia('https://video.twimg.com/x.mp4', { fetchImpl: impl });
  assert.deepEqual(result, { files: null, refused: [] });
});

test('a page past the body cap is refused instead of read into memory', async () => {
  const big = 'x'.repeat(8_000_001);
  const impl = (async () => new Response(big)) as unknown as typeof fetch;

  const page = await readPage('https://www.instagram.com/p/AbCdEf12345/', { fetchImpl: impl });
  assert.equal(page.status, 200);
  assert.equal(page.html, null);
});
