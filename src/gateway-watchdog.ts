import { Events, Status } from 'discord.js';
import type { Client } from 'discord.js';

/** Check each ready shard for dispatch silence only while Discord still acknowledges heartbeats. */
export function watchGateway(
  client: Client,
  timeoutMs: number,
  onTimeout: (shardId: number, silentMs: number) => void,
  now = () => performance.now(),
) {
  const dispatchAt = new Map<number, number>();
  const lastHeartbeat = new Map<number, number>();

  // discord.js emits Raw only for dispatches, including READY and RESUMED.
  client.on(Events.Raw, (_, shardId: number) => dispatchAt.set(shardId, now()));

  const timer = setInterval(() => {
    for (const [shardId, shard] of client.ws.shards) {
      // discord.js changes lastPingTimestamp on ACK. Compare samples, not wall-clock age.
      const previous = lastHeartbeat.get(shardId);
      const heartbeat = shard.lastPingTimestamp;
      lastHeartbeat.set(shardId, heartbeat);
      if (shard.status !== Status.Ready || heartbeat === -1 || previous === undefined || heartbeat === previous) continue;

      const lastDispatch = dispatchAt.get(shardId);
      if (lastDispatch === undefined) continue;
      const silentMs = now() - lastDispatch;
      if (silentMs < timeoutMs) continue;

      clearInterval(timer);
      onTimeout(shardId, silentMs);
      return;
    }
  }, 5_000).unref();
}
