import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { cleanMessage } from './clean.js';
import { buildCards } from './cards.js';

// Shown on the incoming message while the bot works on it, removed afterwards.
const ACK_EMOJI = '👀';

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

/** Keep whole lines only, so a URL is never cut in half. */
function fitLines(lines, max = 2000) {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (length + cost > max) break;
    kept.push(line);
    length += cost;
  }
  return kept;
}

/** An embed whose image came from a file we are no longer sending. */
function withoutAttachmentImages(embed) {
  if (!embed.image?.url?.startsWith('attachment://')) return embed;
  const copy = { ...embed };
  delete copy.image;
  return copy;
}

/** False for an embed that only existed to show one of those images. */
function hasContent(embed) {
  return Boolean(
    embed.title || embed.description || embed.author || embed.footer || embed.image || embed.fields?.length,
  );
}

/**
 * Post the reply, degrading step by step.
 *
 * A card is decoration: a rejected attachment or a missing Embed Links
 * permission must never cost the clean link itself.
 */
async function sendReply(message, { lines, cards }) {
  const carded = new Set(cards.map((card) => card.from));
  const content = fitLines([
    // Angle brackets stop Discord from unfurling the link a second time next
    // to the card we built from it.
    ...cards.map((card) => `<${card.url}>`),
    ...lines.filter(({ from }) => !carded.has(from)).map(({ to }) => to),
  ]).join('\n');

  const files = cards.flatMap((card) => card.files ?? []);
  const embeds = cards.flatMap((card) => card.embeds);

  const attempts = [{ content, allowedMentions: { parse: [] } }];
  if (embeds.length > 0) {
    attempts[0].embeds = embeds;
    if (files.length > 0) attempts[0].files = files;
  }
  if (files.length > 0) {
    attempts.push({
      content,
      allowedMentions: { parse: [] },
      // Image-only embeds have nothing left to show once their file is gone.
      embeds: embeds.map(withoutAttachmentImages).filter(hasContent),
    });
  }
  if (embeds.length > 0) {
    attempts.push({ content: content.replace(/[<>]/g, ''), allowedMentions: { parse: [] } });
  }

  for (const [index, payload] of attempts.entries()) {
    try {
      await message.reply(payload);
      return;
    } catch (error) {
      const last = index === attempts.length - 1;
      if (last) throw error;
      console.log(`[reply] attempt ${index + 1} rejected: ${error.message}`);
    }
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
      console.log(`card ${card.from} -> ${card.embeds[0].url}`);
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
