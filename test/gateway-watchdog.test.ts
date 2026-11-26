import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Client, Events, GatewayIntentBits, GatewayOpcodes, Status } from 'discord.js';
import type { WebSocketShard } from 'discord.js';
import { watchGateway } from '../src/gateway-watchdog.ts';

function gateway({ mock }: TestContext) {
  mock.timers.enable({ apis: ['setInterval'] });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const actions: [number, number][] = [];
  let now = 0;
  watchGateway(client, 30_000, (shard, silentMs) => actions.push([shard, silentMs]), () => now);
  return {
    actions,
    shard(id: number) {
      const shard = { status: Status.Ready, lastPingTimestamp: -1 };
      client.ws.shards.set(id, shard as WebSocketShard);
      return shard;
    },
    advance(ms: number) {
      now += ms;
      mock.timers.tick(ms);
    },
    dispatch(shardId: number) {
      client.emit(Events.Raw, { op: GatewayOpcodes.Dispatch, t: 'TYPING_START' }, shardId);
    },
  };
}

test('a silent shard triggers once only after a new heartbeat ACK', (t) => {
  const { actions, shard, advance, dispatch } = gateway(t);
  const silent = shard(0);
  const active = shard(1);
  dispatch(0);
  advance(5_000);
  silent.lastPingTimestamp = 100;
  advance(5_000);
  advance(25_000);
  active.lastPingTimestamp = 200;
  dispatch(1);
  advance(5_000);
  assert.deepEqual(actions, []);

  // The heartbeat timestamp can step backwards; the silence clock does not.
  silent.lastPingTimestamp = 50;
  advance(5_000);
  assert.deepEqual(actions, [[0, 45_000]]);
  silent.lastPingTimestamp = 300;
  advance(5_000);
  assert.deepEqual(actions, [[0, 45_000]]);
});

test('a non-message dispatch resets the silence deadline', (t) => {
  const { actions, shard, advance, dispatch } = gateway(t);
  const ready = shard(0);
  dispatch(0);
  advance(25_000);
  dispatch(0);
  ready.lastPingTimestamp = 100;
  advance(10_000);
  assert.deepEqual(actions, []);

  ready.lastPingTimestamp = 200;
  advance(25_000);
  assert.deepEqual(actions, [[0, 35_000]]);
});

test('a reconnecting shard stays under discord.js recovery even if an ACK arrives', (t) => {
  const { actions, shard, advance, dispatch } = gateway(t);
  const reconnecting = shard(0);
  dispatch(0);
  advance(35_000);
  reconnecting.status = Status.Connecting;
  reconnecting.lastPingTimestamp = 100;
  advance(5_000);
  assert.deepEqual(actions, []);
});
