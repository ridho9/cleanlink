// One record per handled message, written as a single `[msg] {json}` line when
// the message is done, for the daily review (`mise run review`).
//
// The record is carried by AsyncLocalStorage, so code deep inside a card
// builder can add to it without a parameter being threaded through. Every note
// still goes to the log as its own line, as before; the record only collects
// it under the URL it belongs to.

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/**
 * Start the record for one message.
 * @param {{id: string, where: string}} meta
 */
export function startTrace({ id, where }) {
  return { id, where, started: Date.now(), reply: null, notes: [], urls: new Map() };
}

/** Run `fn` with `trace` as the current record. */
export function runTraced(trace, fn) {
  return store.run({ trace, url: null }, fn);
}

/**
 * Run `fn` with `raw` as the current URL: notes and marks made inside it are
 * filed under that URL. Outside a traced message this is just `fn()`.
 */
export function withUrl(raw, fn) {
  const current = store.getStore();
  if (!current) return fn();
  entryFor(current.trace, raw);
  return store.run({ trace: current.trace, url: raw }, fn);
}

/** Log a line, and file it under the current URL (or the message). */
export function note(text) {
  console.log(text);
  const current = store.getStore();
  if (!current) return;
  if (current.url) entryFor(current.trace, current.url).notes.push(text);
  else current.trace.notes.push(text);
}

/**
 * Record an outcome for the current URL: a field the review counts, so values
 * come from a small fixed set (see README, "Logs and the daily review").
 */
export function mark(field, value) {
  const current = store.getStore();
  if (!current?.url) return;
  entryFor(current.trace, current.url)[field] = value;
}

/** Record how the message itself ended: sent, nothing, refused, deleted, error. */
export function markReply(trace, value) {
  trace.reply = value;
}

/** Write the record as one line. */
export function finishTrace(trace) {
  const record = {
    id: trace.id,
    where: trace.where,
    ms: Date.now() - trace.started,
    reply: trace.reply ?? 'nothing',
    // Outcome fields first, notes last and only when there are any.
    urls: [...trace.urls.values()].map(({ notes, ...outcome }) =>
      (notes.length > 0 ? { ...outcome, notes } : outcome)),
  };
  if (trace.notes.length > 0) record.notes = trace.notes;
  console.log(`[msg] ${JSON.stringify(record)}`);
}

/** An error nothing else caught, as one countable line. */
export function logError(kind, error, extra = {}) {
  console.log(`[error] ${JSON.stringify({
    kind,
    message: String(error?.message ?? error),
    code: error?.code,
    stack: error?.stack?.split('\n').slice(1, 4).map((line) => line.trim()),
    ...extra,
  })}`);
}

function entryFor(trace, raw) {
  let entry = trace.urls.get(raw);
  if (!entry) {
    entry = { in: raw, notes: [] };
    trace.urls.set(raw, entry);
  }
  return entry;
}
