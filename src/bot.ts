import { setDefaultResultOrder } from 'node:dns';

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { handleMessage } from './handler.ts';
import { originalDeleted } from './replies.ts';
import { logError } from './trace.ts';

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

client.on(Events.MessageCreate, (message) => handleMessage(message));
client.on(Events.MessageDelete, (message) => originalDeleted(message.id));

client.on(Events.Error, (error) => logError('gateway', error));

process.on('unhandledRejection', (error) => logError('unhandled_rejection', error));

await client.login(token);
