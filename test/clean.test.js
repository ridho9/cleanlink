import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanMessage, cleanUrl, extractUrls, ruleFor } from '../src/clean.js';

/** Minimal fetch stand-in: returns a 302 when a route matches, else a 200. */
function stubFetch(routes = {}) {
  const calls = [];
  const requests = [];
  const impl = async (url, options = {}) => {
    calls.push(url);
    requests.push(options);
    const location = routes[url];
    return {
      status: location ? 302 : 200,
      headers: new Headers(location ? { location } : {}),
      body: null,
    };
  };
  impl.calls = calls;
  impl.requests = requests;
  return impl;
}

test('extractUrls finds links and trims trailing punctuation', () => {
  assert.deepEqual(extractUrls('look: https://youtu.be/abc?si=1, nice.'), [
    'https://youtu.be/abc?si=1',
  ]);
  assert.deepEqual(extractUrls('<https://youtu.be/abc>'), ['https://youtu.be/abc']);
  assert.deepEqual(extractUrls('no links here'), []);
  assert.deepEqual(extractUrls(undefined), []);
});

test('ruleFor matches subdomains but not lookalike hosts', () => {
  assert.equal(ruleFor(new URL('https://www.threads.com/@a/post/b')).id, 'threads');
  assert.equal(ruleFor(new URL('https://vm.tiktok.com/abc')).id, 'tiktok');
  assert.equal(ruleFor(new URL('https://notthreads.com/@a/post/b')), null);
});

test('strips tracking params from a plain (non-share) link', async () => {
  const fetchImpl = stubFetch();
  assert.equal(
    await cleanUrl('https://youtu.be/dQw4w9WgXcQ?si=abc123', { fetchImpl }),
    'https://youtu.be/dQw4w9WgXcQ',
  );
  assert.equal(
    await cleanUrl('https://www.threads.com/@a/post/b?xmt=xyz&slof=1', { fetchImpl }),
    'https://www.threads.com/@a/post/b',
  );
  assert.equal(fetchImpl.calls.length, 0, 'no redirect hop should be needed');
});

test('resolves an opaque Threads share link, then strips params', async () => {
  const share = 'https://www.threads.com/share/BAbCdEfGhI';
  const fetchImpl = stubFetch({
    [share]:
      'https://www.threads.com/@phodhipo/post/DfPOscPD6UR?xmt=AQFakeXm&slof=1',
  });

  assert.equal(
    await cleanUrl(share, { fetchImpl }),
    'https://www.threads.com/@phodhipo/post/DfPOscPD6UR',
  );
  assert.equal(fetchImpl.calls.length, 1, 'should stop once past the share path');
});

test('resolves shortener hosts', async () => {
  const tiktok = 'https://vm.tiktok.com/ZMabc123';
  const fetchImpl = stubFetch({
    [tiktok]:
      'https://www.tiktok.com/@user/video/7300000000000000000?is_from_webapp=1&sender_device=pc',
  });

  assert.equal(
    await cleanUrl(tiktok, { fetchImpl }),
    'https://www.tiktok.com/@user/video/7300000000000000000',
  );
});

test('resolves a share link whose target also carries tracking params', async () => {
  const share = 'https://www.facebook.com/share/1AbCdEfGhI/';
  const fetchImpl = stubFetch({
    [share]:
      'https://www.facebook.com/1800373075/posts/10227878451145593/?rdid=abc&utm_source=share',
  });

  assert.equal(
    await cleanUrl(share, { fetchImpl }),
    'https://www.facebook.com/1800373075/posts/10227878451145593/',
  );
});

test('never requests a redirect target outside the allowlist', async () => {
  const share = 'https://fb.watch/AbCdEfG';
  const target = 'https://example.com/some/page';
  const fetchImpl = stubFetch({ [share]: target });

  assert.equal(await cleanUrl(share, { fetchImpl }), target);
  assert.deepEqual(fetchImpl.calls, [share], 'target host must not be fetched');
});

test('ignores hosts it does not handle', async () => {
  const fetchImpl = stubFetch();
  assert.equal(await cleanUrl('https://example.com/a?utm_source=x', { fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('returns null when nothing would change', async () => {
  const fetchImpl = stubFetch();
  assert.equal(await cleanUrl('https://youtu.be/dQw4w9WgXcQ', { fetchImpl }), null);
  assert.equal(await cleanUrl('https://www.threads.com/@a/post/b', { fetchImpl }), null);
});

test('survives a failing resolution by returning null', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };

  assert.equal(await cleanUrl('https://www.threads.com/share/BAbCdEfGhI', { fetchImpl }), null);
});

test('a 200 answer without a Location header is left alone', async () => {
  const fetchImpl = stubFetch();
  assert.equal(await cleanUrl('https://www.threads.com/share/BAbCdEfGhI', { fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 1);
});

test('picks the user agent each site expects', async () => {
  // The bare prefix is what these sites redirect. A browser string gets a
  // JavaScript shell from Threads and a 400 from Facebook.
  const threads = stubFetch();
  await cleanUrl('https://www.threads.com/share/BAbCdEfGhI', { fetchImpl: threads });
  assert.equal(threads.requests[0].headers['user-agent'], 'Mozilla/5.0');
  assert.equal(threads.requests[0].redirect, 'manual');

  const facebook = stubFetch();
  await cleanUrl('https://www.facebook.com/share/1AbCdEfGhI/', { fetchImpl: facebook });
  assert.equal(facebook.requests[0].headers['user-agent'], 'Mozilla/5.0');
});

test('rejects shortener redirects that fell back to a front page', async () => {
  const cases = [
    ['https://fb.watch/bogus000', 'https://www.facebook.com/watch/'],
    ['https://vm.tiktok.com/bogus000', 'https://www.tiktok.com/?_r=1'],
  ];

  for (const [input, location] of cases) {
    const fetchImpl = stubFetch({ [input]: location });
    assert.equal(await cleanUrl(input, { fetchImpl }), null, input);
  }
});

test('still resolves a shortener that lands on a real target', async () => {
  const watch = 'https://fb.watch/AbCdEfG';
  const fetchImpl = stubFetch({
    [watch]: 'https://www.facebook.com/watch/?v=123456789',
  });

  assert.equal(
    await cleanUrl(watch, { fetchImpl }),
    'https://www.facebook.com/watch/?v=123456789',
  );
});

test('cleanMessage deduplicates and reports only changed links', async () => {
  const fetchImpl = stubFetch();
  const cleaned = await cleanMessage(
    'https://youtu.be/a?si=1 https://youtu.be/a?si=1 https://x.com/u/status/1?s=20',
    { fetchImpl },
  );

  assert.deepEqual(cleaned, [
    { from: 'https://youtu.be/a?si=1', to: 'https://youtu.be/a' },
    { from: 'https://x.com/u/status/1?s=20', to: 'https://x.com/u/status/1' },
  ]);
});

test('cleanMessage caps the number of links it works on', async () => {
  const fetchImpl = stubFetch();
  const text = Array.from({ length: 8 }, (_, i) => `https://youtu.be/v${i}?si=x`).join(' ');

  assert.equal((await cleanMessage(text, { fetchImpl })).length, 5);
});

test('cleanMessage stays silent when no link is handled', async () => {
  const fetchImpl = stubFetch();
  assert.deepEqual(await cleanMessage('hello there', { fetchImpl }), []);
});

test('drops the X per-share token but keeps nothing else', async () => {
  const fetchImpl = stubFetch();
  assert.equal(
    await cleanUrl('https://x.com/user/status/123?s=20&t=AbCdEf', { fetchImpl }),
    'https://x.com/user/status/123',
  );
});

// Fixtures below are real links, with the exact redirect targets observed live.

test('real link: Instagram share tokens mdxt/psln', async () => {
  const fetchImpl = stubFetch();

  assert.equal(
    await cleanUrl('https://www.instagram.com/reel/DfB2tfoPyrY/?mdxt=ZmFrZW1keHQwMDAw', {
      fetchImpl,
    }),
    'https://www.instagram.com/reel/DfB2tfoPyrY/',
  );
  assert.equal(
    await cleanUrl('https://www.instagram.com/p/DfG4ZQcM3vW/?psln=ZmFrZXBzbG4wMDAw', {
      fetchImpl,
    }),
    'https://www.instagram.com/p/DfG4ZQcM3vW/',
  );
  assert.equal(fetchImpl.calls.length, 0, 'post links need no resolution');
});

test('real link: vt.tiktok.com short link keeps the video, drops _t', async () => {
  const short = 'https://vt.tiktok.com/ZSFake000/';
  const fetchImpl = stubFetch({
    [short]:
      'https://www.tiktok.com/@akunnyaceell/video/7695007813038394645?_t=ZS-FakeShareTok',
  });

  assert.equal(
    await cleanUrl(short, { fetchImpl }),
    'https://www.tiktok.com/@akunnyaceell/video/7695007813038394645',
  );
});

test('real link: facebook /share/ unwraps to the post, drops rdid/share_url', async () => {
  const share = 'https://www.facebook.com/share/1AbCdEfGhI/';
  const fetchImpl = stubFetch({
    [share]:
      'https://www.facebook.com/1800373075/posts/10227878451145593/?rdid=FakeRdid00000000&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F1AbCdEfGhI%2F',
  });

  assert.equal(
    await cleanUrl(share, { fetchImpl }),
    'https://www.facebook.com/1800373075/posts/10227878451145593/',
  );
});

test('facebook resolves with the generic UA, like Threads', async () => {
  const share = 'https://www.facebook.com/share/1AbCdEfGhI/';
  const fetchImpl = stubFetch({
    [share]: 'https://www.facebook.com/1800373075/posts/10227878451145593/',
  });

  await cleanUrl(share, { fetchImpl });
  assert.equal(fetchImpl.requests[0].headers['user-agent'], 'Mozilla/5.0');
});

test('drops unknown tokens on permalinks but leaves other URL shapes alone', async () => {
  const fetchImpl = stubFetch();

  // The `a=` token was invented after the rule table was written.
  assert.equal(
    await cleanUrl(
      'https://x.com/vxunderground/status/2117656394396778956?a=FakeShareToken000000&s=20',
      { fetchImpl },
    ),
    'https://x.com/vxunderground/status/2117656394396778956',
  );

  assert.equal(
    await cleanUrl('https://www.instagram.com/p/DfG4ZQcM3vW/?never_seen=1', { fetchImpl }),
    'https://www.instagram.com/p/DfG4ZQcM3vW/',
  );

  // A search URL must keep its parameters, so this is not ours to touch.
  assert.equal(
    await cleanUrl('https://x.com/search?q=malware&src=typed_query', { fetchImpl }),
    null,
  );
  assert.equal(
    await cleanUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { fetchImpl }),
    null,
  );
});
