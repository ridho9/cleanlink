import { readFileSync } from 'node:fs';

/** Parsed JSON fixture from test/fixtures. */
export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));

/** Raw text fixture, for the scraped HTML pages. */
export const fixtureText = (name) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');

/** A fetch stub that answers by URL prefix and records what it was asked. */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes.find(([prefix]) => String(url).startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    const [, value] = route;
    // A Response body can be read once, so hand out a clone per request; the
    // pixiv builder fetches the same image host several times.
    // A factory builds a fresh response per request, e.g. a streaming body.
    if (typeof value === 'function') return value();
    if (value instanceof Response) return value.clone();
    if (typeof value === 'string') return new Response(value, { status: 200 });
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

export const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export const imageResponse = () =>
  new Response(IMAGE_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
