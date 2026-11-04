import { setDefaultResultOrder } from 'node:dns';

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { cleanMessage, handlesAny } from './clean.js';
import { buildCards, hasCardFor } from './cards/index.js';
import { sendReply } from './reply.js';

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
  partials: [Partials.Channel],
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

/** Strip the preview card from someone else's message, when allowed. */
async function suppressOriginalEmbed(message) {
  // Needs Manage Messages, which only exists in guilds. A DM channel has no
  // permission model at all and answers 50003, so this is guild-only by nature.
  let allowed = false;
  try {
    allowed = Boolean(
      message.channel
        .permissionsFor(message.client.user)
        ?.has(PermissionFlagsBits.ManageMessages),
    );
  } catch (error) {
    console.log(`[guild] could not read permissions: ${error.message}`);
    return;
  }

  if (!allowed) {
    console.log('[guild] no Manage Messages — original embed left in place');
    return;
  }

  try {
    await message.suppressEmbeds(true);
    console.log('[guild] suppressed the original embed');
  } catch (error) {
    console.log(`[guild] suppress failed: ${error.message}`);
  }
}

/** The whole message path, exported so it can be driven without a gateway. */
export async function handleMessage(message) {
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

  // Acknowledge on receipt so it is obvious the message landed, and drop the
  // reaction once the reply is out (or once we know there is nothing to do).
  // A reaction failure must never break the actual work.
  let ack = null;
  try {
    ack = await message.react(ACK_EMOJI);
  } catch (error) {
    console.log(`[ack] could not react: ${error.message}`);
  }

  try {
    const cleaned = await cleanMessage(message.content);
    // Cards are built from the cleaned URL, so a carded link shows its clean
    // form even though it is the one being replaced by an embed.
    const cards = await buildCards(message.content, { cleaned });

    if (cleaned.length === 0 && cards.length === 0) return;

    for (const { from, to } of cleaned) {
      console.log(`cleaned ${from} -> ${to}`);
    }
    for (const card of cards) {
      console.log(`card ${card.from} -> ${card.embeds[0]?.url ?? card.extraLines?.[0]}`);
    }

    if (!isDM) await suppressOriginalEmbed(message);

    await sendReply(message, { lines: cleaned, cards });
  } finally {
    if (ack) {
      try {
        await ack.users.remove(client.user);
      } catch (error) {
        console.log(`[ack] could not remove reaction: ${error.message}`);
      }
    }
  }
}

client.on(Events.MessageCreate, (message) => handleMessage(message));

client.on(Events.Error, (error) => {
  console.error('gateway error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('unhandled rejection:', error);
});

await client.login(token);
