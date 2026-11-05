// Which bot messages answer which user message, so a reply can follow its
// original out of the channel when the user deletes it.
//
// In memory only: after a restart, older replies stay. The map is bounded, so
// a long-running bot does not grow without limit; the oldest entries go first.

import { note } from './trace.js';

const MAX_TRACKED = 1000;

const tracked = new Map();

/**
 * Start tracking the replies to one message.
 * @param {string} id the user's message id
 * @returns {{ add: (sent: { delete: () => Promise<unknown> }) => Promise<void>,
 *   deleted: () => boolean }}
 */
export function track(id) {
  const entry = { sent: [], deleted: false };
  tracked.set(id, entry);
  while (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value);

  return {
    // A reply that lands after the original is gone is removed at once:
    // the delete event has already passed and will not come again.
    add: async (sent) => {
      if (entry.deleted) return remove(sent);
      entry.sent.push(sent);
    },
    deleted: () => entry.deleted,
  };
}

/** The user deleted a message: delete every reply posted to it so far. */
export async function originalDeleted(id) {
  const entry = tracked.get(id);
  if (!entry) return;
  entry.deleted = true;
  const sent = entry.sent.splice(0);
  await Promise.all(sent.map(remove));
  // Kept, marked deleted, so replies still in flight are caught by add().
}

async function remove(sent) {
  try {
    await sent.delete();
    note('[reply] deleted: its original was deleted');
  } catch (error) {
    // Already gone (deleted by a moderator, say): nothing left to do.
    note(`[reply] could not delete: ${error.message}`);
  }
}
