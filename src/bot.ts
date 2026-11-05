import { setDefaultResultOrder } from 'node:dns';

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import type { GuildTextBasedChannel, Message, OmitPartialGroupDMChannel } from 'discord.js';
import type { Trace } from './trace.ts';
import { cleanMessage, handlesAny } from './clean.ts';
import { buildCards, hasCardFor } from './cards/index.ts';
import { sendReply } from './reply.ts';
import { originalDeleted, track } from './replies.ts';
import { finishTrace, logError, markReply, note, runTraced, startTrace } from './trace.ts';

// Shown on the incoming message while the bot works on it, removed afterwards.
const ACK_EMOJI = '👀';

// Prefer IPv4 for outbound requests.
//
// Measured on bot-host: `api.fxtwitter.com` over IPv6 took 1.01 s to set up
// TLS and 3.05 s end to end, against 0.08 s and 0.42 s over IPv4, with an
// occasional 20 s stall — long enough to blow the 6 s card timeout and lose the
// card silently. Every other host is unaffected in practice, and a host with
// IPv4 keeps working.
setDefaultResultOrder('ipv4first');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Paste your bot token into .env (DISCORD_TOKEN=...).');
  process.exit(1);
}

const client = new Client({
  intents: [
    // Required to resolve guilds, channels and roles at all. Without it the
    // client keeps a skeletal guild (no name, no role cache) and any
    // permissionsFor() call throws on the empty role cache.
    GatewayIntentBits.Guilds,
    // Receive DM events at all.
    GatewayIntentBits.DirectMessages,
    // Receive channel messages, for server mode.
    GatewayIntentBits.GuildMessages,
    // Read the text of messages (privileged: enable it in the Developer Portal).
    GatewayIntentBits.MessageContent,
  ],
  // Required for DMs. Without it discord.js resolves the channel with a plain
  // cache lookup, and a DM channel is never in the cache, so the message is
  // dropped before `messageCreate` is ever emitted — silently, while the raw
  // packet still arrives. This is the bug that makes a DM bot look dead.
  // Message: a delete event for a message no longer in the cache arrives
  // as a partial, and without this it is dropped - the reply would stay.
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (ready) => {
  console.log(`logged in as ${ready.user.tag}`);
  console.log('DM the bot a link, or post one in a channel, to get the clean one back.');

  if (process.env.DEBUG) {
    // A connected socket can still be silent if Discord invalidated the
    // session, so print the shard state and heartbeat periodically.
    setInterval(() => {
      console.log(
        `[ws] status=${client.ws.status} ping=${client.ws.ping}ms uptime=${Math.round(process.uptime())}s`,
      );
    }, 10_000).unref();
  }
});

if (process.env.DEBUG) {
  client.on(Events.Raw, (packet) => console.log(`[raw] ${packet.t}`));
  client.on(Events.Debug, (msg) => {
    if (/heartbeat|identify|session|resume|zombie|close|reconnect/i.test(msg)) {
      console.log(`[debug] ${msg}`);
    }
  });
}

client.on(Events.Warn, (msg) => console.log(`[warn] ${msg}`));

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
    try {
      await work(message, isDM, trace);
    } catch (error) {
      markReply(trace, 'error');
      logError('handler', error, { id: message.id });
    } finally {
      finishTrace(trace);
    }
  });
}

/** Hide, react, clean, card, reply - the part of the path that is traced. */
async function work(message: OmitPartialGroupDMChannel<Message>, isDM: boolean, trace: Trace) {
  // Tracked from receipt, so a delete during the work below is not missed.
  const replies = track(message.id);

  // Hide the original preview first, before anything else, so the channel
  // does not show it and then swap it for our card a few seconds later. Every
  // path that ends without a reply hands it back (see finally): it was our doing.
  const suppressed = isDM ? false : await suppressOriginalEmbed(message);
  let replied = false;

  // Acknowledge on receipt so it is obvious the message landed, and drop the
  // reaction once the reply is out (or once we know there is nothing to do).
  // A reaction failure must never break the actual work.
  let ack = null;
  try {
    ack = await message.react(ACK_EMOJI);
  } catch (error) {
    note(`[ack] could not react: ${(error as Error).message}`);
  }

  try {
    const cleaned = await cleanMessage(message.content);
    // Cards are built from the cleaned URL, so a carded link shows its clean
    // form even though it is the one being replaced by an embed.
    const cards = await buildCards(message.content, { cleaned });

    if (cleaned.length === 0 && cards.length === 0) {
      markReply(trace, 'nothing');
      return;
    }

    for (const { from, to } of cleaned) {
      console.log(`cleaned ${from} -> ${to}`);
    }
    for (const card of cards) {
      console.log(`card ${card.from} -> ${card.embeds[0]?.url ?? card.followUp}`);
    }

    // The user may delete the message while the cards are built; then there
    // is no one left to answer.
    if (replies.deleted()) {
      markReply(trace, 'deleted');
      return;
    }
    try {
      await sendReply(message, { lines: cleaned, cards }, { onSent: replies.add });
      replied = true;
      markReply(trace, replies.deleted() ? 'deleted' : 'sent');
    } catch (error) {
      // A permission the bot lacks — most often Send Messages in Threads — is
      // not a gateway fault and not something a retry fixes. Say so once; the
      // preview comes back in finally.
      const detail = error as { status?: number; message?: string; code?: string } | null | undefined;
      if (detail?.status === 403 || detail?.status === 404) {
        note(`[reply] cannot post in this channel: ${detail.message} (${detail.code})`);
        markReply(trace, 'refused');
        return;
      }
      throw error;
    }
  } finally {
    if (suppressed && !replied && !replies.deleted()) await restoreOriginalEmbed(message);
    if (ack) {
      try {
        await ack.users.remove(client.user!);
      } catch (error) {
        note(`[ack] could not remove reaction: ${(error as Error).message}`);
      }
    }
  }
}

client.on(Events.MessageCreate, (message) => handleMessage(message));
client.on(Events.MessageDelete, (message) => originalDeleted(message.id));

client.on(Events.Error, (error) => logError('gateway', error));

process.on('unhandledRejection', (error) => logError('unhandled_rejection', error));

await client.login(token);
