import { expect, test } from 'bun:test';
import { decodeRebalance } from '../src/bos.ts';

const { enforceRebalanceLimits } = require('../src/rebalance-limits.cjs');
const hash = Buffer.alloc(32, 1);
const limit = { amount: 54_333, maxFee: 271, maxFeeRate: 5_000 };

function fixture() {
  const calls = { invoices: 0, payments: 0 };
  const lnd = {
    default: { addInvoice(_request: any, callback: any) { calls.invoices++; callback(null, { r_hash: hash }); } },
    router: { sendToRouteV2(_request: any, callback: any) { calls.payments++; callback(null, { success: true }); } },
  };
  enforceRebalanceLimits(lnd, limit);
  const invoke = (method: any, request: any) => new Promise((resolve, reject) => method(request, (error: any, response: any) => error ? reject(error) : resolve(response)));
  return {
    lnd,
    calls,
    invoice: (msats = '54333000') => invoke(lnd.default.addInvoice, { value_msat: msats }),
    pay: (amount: bigint, fee: bigint, override: any = {}) => invoke(lnd.router.sendToRouteV2, {
      payment_hash: hash,
      route: { total_amt_msat: String(amount + fee), total_fees_msat: String(fee), hops: [{ amt_to_forward_msat: String(amount) }], ...override },
    }),
  };
}

test('blocks an oversized invoice before it reaches LND', async () => {
  const f = fixture();
  await expect(f.invoice('219028000')).rejects.toThrow('RebalanceInvoiceAmountOutsideLimit');
  expect(f.calls).toEqual({ invoices: 0, payments: 0 });
});

test('ln-service invoice errors preserve the guard rejection through the worker', async () => {
  const { createInvoice } = require('ln-service');
  const { workerFailure } = require('../src/bos-worker-errors.cjs');
  const f = fixture();
  let failure;
  try { await createInvoice({ lnd: f.lnd, tokens: 219_028 }); }
  catch (error) { failure = workerFailure(error, 'executing BOS rebalance'); }
  expect(failure).toMatchObject({ reason: 'AddInvoiceError', diagnostics: { guardReason: 'RebalanceInvoiceAmountOutsideLimit', rpcStatus: 'INVALID_ARGUMENT' } });
  expect(decodeRebalance(failure)).toEqual({ status: 'failed', reason: 'AddInvoiceError (RebalanceInvoiceAmountOutsideLimit; INVALID_ARGUMENT)', stop: true });
  expect(f.calls).toEqual({ invoices: 0, payments: 0 });
});

test('independently blocks an oversized final route before payment', async () => {
  const f = fixture();
  await f.invoice();
  await expect(f.pay(219_028_000n, 164_000n)).rejects.toThrow('RebalancePaymentAmountOutsideLimit');
  expect(f.calls.payments).toBe(0);
});

test('allows a compliant final route', async () => {
  const f = fixture();
  await f.invoice();
  await expect(f.pay(54_333_000n, 164_000n)).resolves.toEqual({ success: true });
  expect(f.calls.payments).toBe(1);
});

test('checks fractional fees and the rate on the final payment amount', async () => {
  for (const [amount, fee] of [[54_333_000n, 271_001n], [50_000_000n, 260_000n]]) {
    const f = fixture();
    await f.invoice();
    await expect(f.pay(amount!, fee!)).rejects.toThrow('RebalancePaymentFeeOutsideLimit');
    expect(f.calls.payments).toBe(0);
  }
});

test('malformed or inconsistent routes never reach the payment RPC', async () => {
  for (const override of [{ total_amt_msat: 'invalid' }, { hops: [] }, { hops: [{ amt_to_forward_msat: '1' }] }]) {
    const f = fixture();
    await f.invoice();
    await expect(f.pay(54_333_000n, 164_000n, override)).rejects.toThrow();
    expect(f.calls.payments).toBe(0);
  }
});

test('BOS cannot create a second payable invoice within one attempt', async () => {
  const f = fixture();
  await f.invoice();
  await expect(f.invoice()).rejects.toThrow('RebalanceInvoiceAmountOutsideLimit');
  expect(f.calls.invoices).toBe(1);
});
