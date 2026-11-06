// The message path: hide the preview, react, clean, card, reply, and clean up.
// Kept apart from bot.ts, which owns the gateway client and logs in on import,
// so the tests can drive it with a fake message.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildTextBasedChannel, Message, OmitPartialGroupDMChannel } from 'discord.js';
import type { Outcome } from './trace.ts';
import type { Replies } from './replies.ts';
import { cleanMessage, handlesAny } from './clean.ts';
import { buildCards, hasCardFor } from './cards/index.ts';
import { sendReply } from './reply.ts';
import { track } from './replies.ts';
import { finishTrace, logError, markReply, note, runTraced, startTrace } from './trace.ts';

// Shown on the incoming message while the bot works on it, removed afterwards.
const ACK_EMOJI = '👀';

/**
 * Strip the preview card from someone else's message, when allowed.
 * @returns True when the embed was actually suppressed.
 */
async function suppressOriginalEmbed(message: Message) {
  // Needs Manage Messages, which only exists in guilds. A DM channel has no
  // permission model at all and answers 50003, so this is guild-only by nature.
  let allowed = false;
  try {
    allowed = Boolean(
      (message.channel as GuildTextBasedChannel)
        .permissionsFor(message.client.user)
        ?.has(PermissionFlagsBits.ManageMessages),
    );
  } catch (error) {
    note(`[guild] could not read permissions: ${(error as Error).message}`);
    return;
  }

  if (!allowed) {
    note('[guild] no Manage Messages — original embed left in place');
    return;
  }

  try {
    await message.suppressEmbeds(true);
    note('[guild] suppressed the original embed');
    return true;
  } catch (error) {
    note(`[guild] suppress failed: ${(error as Error).message}`);
    return false;
  }
}

/** Put the original preview back after a reply that never went out. */
async function restoreOriginalEmbed(message: Message) {
  try {
    await message.suppressEmbeds(false);
    note('[guild] restored the original embed');
  } catch (error) {
    note(`[guild] could not restore the embed: ${(error as Error).message}`);
  }
}

/** The whole message path, exported so it can be driven without a gateway. */
export async function handleMessage(message: OmitPartialGroupDMChannel<Message>) {
  // Logged before any filter, so a missing line means the event never arrived
  // (intent, mutual-server, or a second client stealing the session) rather
  // than "it arrived and was filtered out".
  if (process.env.DEBUG) {
    const where = message.guild ? `guild:${message.guild.name}` : 'DM';
    console.log(
      `[event] ${where} channel=${message.channel.type} author=${message.author.tag} bot=${message.author.bot} chars=${message.content.length} text=${JSON.stringify(message.content.slice(0, 100))}`,
    );
  }

  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  // Ignore group DMs and anything else that is neither a DM nor a guild channel.
  if (!isDM && !message.guild) return;

  // Do not react to a message there is nothing to do with. The check is two
  // regex passes, so it is cheaper than the ack reaction it avoids.
  if (!handlesAny(message.content) && !hasCardFor(message.content)) return;

  // From here on the message is ours: one `[msg]` record is written for it
  // whatever happens, and an error is logged with its id instead of escaping.
  const trace = startTrace({
    id: message.id,
    where: isDM ? 'dm' : `${message.guild!.name} #${(message.channel as GuildTextBasedChannel).name ?? message.channel.id}`,
  });
  await runTraced(trace, async () => {
    // A throw anywhere below leaves this value in place.
    let outcome: Outcome = 'error';
    try {
      outcome = await work(message, isDM);
    } catch (error) {
      logError('handler', error, { id: message.id });
    } finally {
      markReply(trace, outcome);
      finishTrace(trace);
    }
  });
}

/**
 * Whether the original preview must come back. It was hidden on receipt, so
 * it is handed back on every path where no reply of ours took its place.
 */
function mustRestore(outcome: Outcome): boolean {
  switch (outcome) {
    case 'sent':
    case 'withdrawn':
    case 'deleted':
      return false;
    case 'nothing':
    case 'refused':
    case 'error':
      return true;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** Hide, react, then deliver; hand the preview back and drop the reaction after. */
async function work(message: OmitPartialGroupDMChannel<Message>, isDM: boolean): Promise<Outcome> {
  // Tracked from receipt, so a delete during the work below is not missed.
  const replies = track(message.id);

  // Hide the original preview first, before anything else, so the channel
  // does not show it and then swap it for our card a few seconds later.
  const suppressed = isDM ? false : await suppressOriginalEmbed(message);

  // Acknowledge on receipt so it is obvious the message landed, and drop the
  // reaction once the reply is out (or once we know there is nothing to do).
  // A reaction failure must never break the actual work.
  let ack = null;
  try {
    ack = await message.react(ACK_EMOJI);
  } catch (error) {
    note(`[ack] could not react: ${(error as Error).message}`);
  }

  let outcome: Outcome = 'error';
  try {
    outcome = await deliver(message, replies);
    return outcome;
  } finally {
    replies.close();
    // A deleted original has no preview left to restore, whatever the outcome.
    if (suppressed && mustRestore(outcome) && !replies.deleted()) {
      await restoreOriginalEmbed(message);
    }
    // Hide it once more after the reply, as a best effort: Discord's own
    // preview sometimes lands after the first hide and shows anyway. One more
    // request per reply; a failure is only noted.
    if (suppressed && outcome === 'sent' && !replies.deleted()) {
      try {
        await message.suppressEmbeds(true);
      } catch (error) {
        note(`[guild] second suppress failed: ${(error as Error).message}`);
      }
    }
    if (ack) {
      try {
        await ack.users.remove(message.client.user);
      } catch (error) {
        note(`[ack] could not remove reaction: ${(error as Error).message}`);
      }
    }
  }
}

/** Clean, card, reply. Returns how it ended; throws only on an unexpected error. */
async function deliver(
  message: OmitPartialGroupDMChannel<Message>,
  replies: Replies,
): Promise<Outcome> {
  const cleaned = await cleanMessage(message.content);
  // Cards are built from the cleaned URL, so a carded link shows its clean
  // form even though it is the one being replaced by an embed.
  const cards = await buildCards(message.content, { cleaned });

  if (cleaned.length === 0 && cards.length === 0) return 'nothing';

  for (const { from, to } of cleaned) {
    console.log(`cleaned ${from} -> ${to}`);
  }
  for (const card of cards) {
    console.log(`card ${card.from} -> ${card.embeds[0]?.url ?? card.followUp}`);
  }

  // The user may delete the message while the cards are built; then there
  // is no one left to answer.
  if (replies.deleted()) return 'deleted';

  try {
    await sendReply(message, { lines: cleaned, cards }, { onSent: replies.add });
  } catch (error) {
    // A permission the bot lacks — most often Send Messages in Threads — is
    // not a gateway fault and not something a retry fixes. Say so once; the
    // preview comes back in work().
    const detail = error as { status?: number; message?: string; code?: string } | null | undefined;
    if (detail?.status === 403 || detail?.status === 404) {
      note(`[reply] cannot post in this channel: ${detail.message} (${detail.code})`);
      return 'refused';
    }
    throw error;
  }
  // Deleted while the reply was in flight: add() has already removed it.
  return replies.deleted() ? 'withdrawn' : 'sent';
}
