import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { decodeRebalance } from '../src/bos.ts';

// Exercise the installed (patched) BOS task graph. Only external LND/network
// responses are stubbed, including the oversized route maximum from the bug.
const filename = require.resolve('balanceofsatoshis/swaps/rebalance');
const bosRequire = createRequire(filename);

async function exerciseRebalance(maximum: number, probeError?: unknown, invoiceError?: unknown, paymentError?: unknown) {
  const self = '02' + '11'.repeat(32);
  const source = '02' + '22'.repeat(32);
  const target = '02' + '33'.repeat(32);
  const ids = ['1x1x0', '2x2x0', '3x3x0'];
  const edges = [[self, source], [source, target], [target, self]].map((keys, i) => ({
    id: ids[i], capacity: 10_000_000,
    policies: keys.map(public_key => ({ public_key, fee_rate: 0, base_fee_mtokens: '0' })),
  }));
  const channels = [
    { id: ids[0], partner_public_key: source, local_balance: 5_000_000, remote_balance: 1_000_000 },
    { id: ids[2], partner_public_key: target, local_balance: 100_000, remote_balance: 5_000_000 },
  ].map(c => ({ ...c, capacity: 10_000_000, is_active: true, local_reserve: 10_000, remote_reserve: 10_000, is_partner_initiated: false, policies: edges.find(e => e.id === c.id)!.policies }));
  let probeAmount = 0;
  let invoiceAmount = 0;
  let paidAmount = 0;
  const lnService = {
    getIdentity: (_: any, cb: any) => cb(null, { public_key: self }),
    getChannels: (args: any, cb: any) => cb(null, { channels: channels.filter(c => !args.partner_public_key || args.partner_public_key === c.partner_public_key) }),
    getNode: (args: any, cb: any) => cb(null, { alias: args.public_key, channels: [edges[0], edges[2]] }),
    getChannel: ({ id }: any, cb: any) => cb(null, edges.find(c => c.id === id)),
    getHeight: (_: any, cb: any) => cb(null, { current_block_height: 1_000_000 }),
    createInvoice: ({ tokens }: any, cb: any) => {
      invoiceAmount = tokens;
      if (invoiceError) return cb(invoiceError);
      cb(null, { id: '44'.repeat(32), tokens, mtokens: String(tokens * 1000) });
    },
    routeFromChannels: ({ mtokens }: any) => ({ route: {
      mtokens: String(BigInt(mtokens) + 164_000n), tokens: Number(BigInt(mtokens) / 1000n) + 164,
      fee: 164, fee_mtokens: '164000', hops: [{ public_key: target, fee: 164 }],
    } }),
    payViaRoutes: ({ routes }: any, cb: any) => {
      paidAmount = routes[0].tokens - routes[0].fee;
      if (paymentError) return cb(paymentError);
      cb(null, { fee: routes[0].fee, tokens: routes[0].tokens });
    },
  };
  const dependencies: Record<string, any> = {
    'ln-service': lnService,
    'ln-sync': { getPeerLiquidity: (_: any, cb: any) => cb(null, { inbound: 5_000_000, outbound: 1_000_000 }) },
    './../display': { formatFeeRate: ({ rate }: any) => ({ display: String(rate) }) },
    './../routing': { getIgnores: (_: any, cb: any) => cb(null, { ignore: [] }) },
    './find_rebalance_peer': ({ query }: any, cb: any) => cb(null, { public_key: query }),
    './../network': { probeDestination: (args: any, cb: any) => {
      probeAmount = args.tokens;
      if (probeError) return cb(probeError);
      // Deliberately exceed the requested small amount: invoice creation must
      // still independently clamp it, even if route discovery regresses.
      cb(null, { success: ids, route_maximum: 219_028 });
    } },
  };
  const module = { exports: {} as any };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, require: (id: string) => dependencies[id] ?? bosRequire(id),
  }, { filename });
  const { workerFailure } = require('../src/bos-worker-errors.cjs');
  const outcome = await module.exports({
    lnd: {}, fs: { getFile: (_: any, cb: any) => cb(null, undefined) }, logger: { info() {} },
    avoid: [], in_filters: [], out_filters: [], in_through: target, out_through: source,
    max_rebalance: String(maximum), max_fee: 271, max_fee_rate: 5_000,
  }).then(
    (result: unknown) => decodeRebalance({ ok: true, result }),
    (error: unknown) => decodeRebalance(workerFailure(error, 'rebalancing')),
  );
  return { outcome, probeAmount, invoiceAmount, paidAmount };
}

test.each([50_000, 54_333, 92_556, 336_185, 500_000])('BOS caps its probe and payment when requesting %i sats', async maximum => {
  const { outcome, probeAmount, invoiceAmount, paidAmount } = await exerciseRebalance(maximum);
  expect(probeAmount).toBeGreaterThan(0);
  expect(probeAmount).toBeLessThanOrEqual(maximum);
  expect(invoiceAmount).toBe(Math.min(maximum, 219_028));
  expect(paidAmount).toBe(invoiceAmount);
  expect(outcome).toEqual({ status: 'success', moved: paidAmount, fee: 165, paymentId: '44'.repeat(32) });
});

test('a fee change during BOS probing fails before invoice creation or payment', async () => {
  const { outcome, invoiceAmount, paidAmount } = await exerciseRebalance(500_000, [503, 'FeeIncreasedOnChannel', { id: '2x2x0' }]);
  expect(outcome).toEqual({ status: 'failed', reason: 'FeeIncreasedOnChannel' });
  expect(invoiceAmount).toBe(0);
  expect(paidAmount).toBe(0);
});

test('BOS never submits payment when invoice creation fails', async () => {
  const error = [503, 'AddInvoiceError', { err: { code: 14, details: 'private RPC message' } }];
  const { outcome, invoiceAmount, paidAmount } = await exerciseRebalance(50_000, undefined, error);
  expect(invoiceAmount).toBe(50_000);
  expect(paidAmount).toBe(0);
  expect(outcome).toEqual({ status: 'failed', reason: 'AddInvoiceError (UNAVAILABLE)', stop: true });
});

test('invoice error text nested in a payment failure cannot release the reservation', async () => {
  const error = [503, 'AddInvoiceError'];
  const { outcome, paidAmount } = await exerciseRebalance(50_000, undefined, undefined, error);
  expect(paidAmount).toBe(50_000);
  expect(outcome).toEqual({ status: 'unknown', reason: 'UnexpectedErrExecutingRebalance' });
});
