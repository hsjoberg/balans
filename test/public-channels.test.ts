import { expect, test } from 'bun:test';

const { publicChannelsOnly } = require('../src/public-channels.cjs');

test('all BOS channel reads force public-only and strip private responses before decoding', async () => {
  const requests: any[] = [];
  const lnd = { default: {
    listChannels(request: any, callback: any) {
      requests.push(request);
      callback(null, { channels: [
        { chan_id: '1', remote_pubkey: 'same-peer', private: false },
        { chan_id: '2', remote_pubkey: 'same-peer', private: true },
        { chan_id: '3', remote_pubkey: 'private-peer', private: true },
        { chan_id: '4', remote_pubkey: 'unknown-visibility' },
      ] });
      return 'rpc-handle';
    },
  } };
  publicChannelsOnly(lnd);
  for (const request of [{}, { active_only: true, private_only: true, public_only: false }]) {
    const response = await new Promise<any>((resolve, reject) => {
      const handle = lnd.default.listChannels(request, (error: unknown, response: any) => error ? reject(error) : resolve(response));
      expect(handle).toBe('rpc-handle');
    });
    expect(response.channels).toEqual([{ chan_id: '1', remote_pubkey: 'same-peer', private: false }]);
  }
  expect(requests).toEqual([
    { public_only: true, private_only: false },
    { active_only: true, public_only: true, private_only: false },
  ]);
});

test('BOS does not request the unfilterable pending-channel inventory', async () => {
  let pendingReads = 0;
  const lnd = { default: {
    listChannels() {},
    pendingChannels(_request: any, _callback: any) { pendingReads++; },
  } };
  publicChannelsOnly(lnd);
  const { getPendingChannels } = require('ln-service');
  expect(await getPendingChannels({ lnd })).toEqual({ pending_channels: [] });
  expect(pendingReads).toBe(0);
});

test('public-only query errors are preserved', async () => {
  const failure = new Error('unavailable');
  const lnd = { default: { listChannels(_request: any, callback: any) { callback(failure); } } };
  publicChannelsOnly(lnd);
  await expect(new Promise((resolve, reject) => lnd.default.listChannels({}, (error: unknown, response: any) => error ? reject(error) : resolve(response)))).rejects.toBe(failure);
});
