// Which bot messages answer which user message, so a reply can follow its
// original out of the channel when the user deletes it.
//
// In memory only: after a restart, older replies stay. The map is bounded, so
// a long-running bot does not grow without limit; the oldest entries go first,
// except entries whose handler is still running (see evict).

import { note } from './trace.ts';

const MAX_TRACKED = 1000;

export interface DeletableMessage {
  delete: () => Promise<unknown>;
}

/**
 * `open`: the handler is still running, so replies may still arrive.
 * `closed`: the handler finished; the replies stay until the original goes.
 * `deleted`: the original is gone; a reply that arrives now is removed at once.
 */
type EntryState = 'open' | 'closed' | 'deleted';

interface TrackedReplies {
  state: EntryState;
  sent: DeletableMessage[];
}

export interface Replies {
  add: (sent: DeletableMessage) => Promise<void>;
  deleted: () => boolean;
  /** The handler is done: the entry may now be evicted. */
  close: () => void;
}

const tracked = new Map<string, TrackedReplies>();

/**
 * Start tracking the replies to one message.
 * @param id The user's message id.
 */
export function track(id: string): Replies {
  const entry: TrackedReplies = { state: 'open', sent: [] };
  tracked.set(id, entry);
  evict();

  return {
    // A reply that lands after the original is gone is removed at once:
    // the delete event has already passed and will not come again.
    add: async (sent) => {
      if (entry.state === 'deleted') return remove(sent);
      entry.sent.push(sent);
    },
    deleted: () => entry.state === 'deleted',
    close: () => {
      if (entry.state === 'open') entry.state = 'closed';
    },
  };
}

/**
 * Drop the oldest entries past the bound. An open entry is skipped: its reply
 * may still be in flight, and without the entry a later delete of the
 * original would not find the reply.
 */
function evict() {
  for (const [id, entry] of tracked) {
    if (tracked.size <= MAX_TRACKED) return;
    if (entry.state !== 'open') tracked.delete(id);
  }
}

/** The user deleted a message: delete every reply posted to it so far. */
export async function originalDeleted(id: string) {
  const entry = tracked.get(id);
  if (!entry) return;
  entry.state = 'deleted';
  const sent = entry.sent.splice(0);
  await Promise.all(sent.map(remove));
  // Kept, marked deleted, so replies still in flight are caught by add().
}

async function remove(sent: DeletableMessage) {
  try {
    await sent.delete();
    note('[reply] deleted: its original was deleted');
  } catch (error) {
    // Already gone (deleted by a moderator, say): nothing left to do.
    note(`[reply] could not delete: ${(error as Error).message}`);
  }
}
