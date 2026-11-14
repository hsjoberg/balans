import { expect, test } from 'bun:test';
import { formatSessionReport } from '../src/session-report.ts';
import { runSession, type SessionSummary } from '../src/runner.ts';
import type { Backend, Channel, OutboundPlan } from '../src/model.ts';
import { decodeRebalance } from '../src/bos.ts';

const channel = (id: string, peer: string, local: number): Channel => ({ id, peer, alias: peer, local, remote: 5_000_000 - local, capacity: 5_000_000, active: true, reserve: 10_000, remoteReserve: 10_000, pending: 0 });
const plan: OutboundPlan = { mode: 'outbound', node: 'demo', sources: [{ peer: 'Source', floor: 1_000_000 }], targets: [{ peer: 'Target', minimum: 1_000_000 }], budget: 15_000, maxFee: 5_000, maxFeeRate: 5_500, chunk: 500_000, minutes: 5, maxAttemptsPerItem: 1 };

test('captures fresh before/after observations separately from confirmed transfer amounts', async () => {
  const channels = [channel('1', 'Source', 3_000_000), channel('2', 'Target', 500_000)];
  const backend: Backend = {
    snapshot: async () => channels, // Mutable backend data must not mutate the baseline.
    rebalance: async () => {
      channels[0]!.local -= 500_400;
      channels[1]!.local += 490_000; // Another forward spent 10k during the session.
      return { status: 'success', moved: 500_000, fee: 400 };
    },
  };
  const summary = await runSession(plan, backend, () => {});
  expect(summary.before?.map(c => c.local)).toEqual([3_000_000, 500_000]);
  expect(summary.after?.map(c => c.local)).toEqual([2_499_600, 990_000]);
  expect(summary.results[0]?.outcome).toEqual({ status: 'success', moved: 500_000, fee: 400 });
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('1 succeeded · 0 failed · 1 attempt');
  expect(report).toContain('1. Source → Target');
  expect(report).toContain('500,000 → 990,000 (+490,000)');
  expect(report).toContain('3,000,000 → 2,499,600 (−500,400)');
  expect(report).toContain('10,000 sats short');
  expect(report).toContain('Attempt limit reached: 1 / 1 for this destination.');
  expect(report).toContain('Moved 500,000 sats');
});

test('a failed final read retains confirmed actions and does not present stale balances', async () => {
  let reads = 0;
  const backend: Backend = {
    snapshot: async () => {
      if (++reads > 1) throw new Error('offline');
      return [channel('1', 'Source', 3_000_000), channel('2', 'Target', 0)];
    },
    rebalance: async () => ({ status: 'success', moved: 500_000, fee: 400 }),
  };
  const summary = await runSession(plan, backend, () => {});
  expect(summary.after).toBeUndefined();
  expect(summary.balanceReadFailed).toBe(true);
  expect(summary.moved).toBe(500_000);
  expect(summary.spent).toBe(400);
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('Final balances unavailable');
  expect(report).toContain('0 → unavailable');
  expect(report).toContain('Target minimum: 1,000,000 sats · unverified');
  expect(report).toContain('Moved 500,000 sats');
});

test('an unsuccessful initial read submits nothing and reports no baseline', async () => {
  const summary = await runSession(plan, {
    snapshot: async () => { throw new Error('offline'); },
    rebalance: async () => { throw new Error('must not run'); },
  }, () => {});
  expect(summary.attempts).toBe(0);
  expect(summary.before).toBeUndefined();
  expect(formatSessionReport(plan, summary)).toContain('No rebalances submitted.');
});

test('reports individual channels in a shared peer and checks the combined target', () => {
  const summary: SessionSummary = {
    spent: 0, moved: 0, attempts: 0, reason: 'targets reached', results: [], balanceReadFailed: false,
    before: [channel('1', 'Target', 100_000), channel('2', 'Target', 200_000)],
    after: [channel('1', 'Target', 800_000), channel('2', 'Target', 200_000)],
  };
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('Target · destination · 2 channels');
  expect(report).toContain('1: 100,000 → 800,000 (+700,000)');
  expect(report).toContain('2: 200,000 → 200,000 (0)');
  expect(report).toContain('Target minimum: 1,000,000 sats · met');
});

test('missing channels stay unavailable instead of becoming a fabricated zero balance', () => {
  const summary: SessionSummary = {
    spent: 0, moved: 0, attempts: 0, reason: 'no eligible pair', results: [], balanceReadFailed: false,
    before: [channel('1', 'Target', 100_000)], after: [],
  };
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('100,000 → unavailable');
  expect(report).not.toContain('−100,000');
});

test('unresolved attempts are not reported as successful moves or paid fees', async () => {
  const summary = await runSession(plan, {
    snapshot: async () => [channel('1', 'Source', 3_000_000), channel('2', 'Target', 0)],
    rebalance: async () => ({ status: 'unknown', reason: 'connection lost' }),
  }, () => {});
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('0 succeeded · 0 failed · 1 unresolved');
  expect(report).toContain('Confirmed moved: 0 sats · Confirmed fees: ≈0 sats');
  expect(report).toContain('Reserved for unresolved payments: 2,751 sats');
  expect(report).toContain('Unresolved payment: connection lost');
});

test('invoice creation failure is reported as a stopped unpaid attempt without reserved fees', async () => {
  const summary = await runSession(plan, {
    snapshot: async () => [channel('1', 'Source', 3_000_000), channel('2', 'Target', 0)],
    rebalance: async () => decodeRebalance({ ok: false, reason: 'AddInvoiceError' }),
  }, () => {});
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('Session ended: stopped before payment: AddInvoiceError.');
  expect(report).toContain('0 succeeded · 1 failed · 1 attempt');
  expect(report).toContain('Failed before payment · session stopped: AddInvoiceError');
  expect(report).toContain('Budget remaining: 15,000 / 15,000 sats');
  expect(report).not.toContain('unresolved');
});

test('cancellation still captures final balances after the current attempt', async () => {
  const channels = [channel('1', 'Source', 3_000_000), channel('2', 'Target', 0)];
  let stop = false;
  const summary = await runSession({ ...plan, maxAttemptsPerItem: 10 }, {
    snapshot: async () => channels,
    rebalance: async () => {
      channels[1]!.local = 100_000;
      stop = true;
      return { status: 'success', moved: 100_000, fee: 100 };
    },
  }, () => {}, () => stop);
  expect(summary.reason).toBe('stopped by operator');
  expect(summary.after?.find(c => c.peer === 'Target')?.local).toBe(100_000);
});

test('keeps an oversized BOS receipt in the report and journal without continuing', async () => {
  const events: any[] = [];
  const receipt = { moved: 219_028, fee: 165, paymentId: 'ab'.repeat(32) };
  const summary = await runSession({ ...plan, maxAttemptsPerItem: 20, maxFeeRate: 5_000 }, {
    snapshot: async () => [channel('1', 'Source', 3_000_000), channel('2', 'Target', 945_667)],
    rebalance: async () => ({ status: 'success', ...receipt }),
  }, event => events.push(event));
  expect(summary.attempts).toBe(1);
  expect(summary.spent).toBe(272);
  expect(summary.moved).toBe(0);
  expect(events.at(-1).outcome).toMatchObject({ status: 'unknown', reported: receipt });
  const report = formatSessionReport(plan, summary);
  expect(report).toContain('BOS reported 219,028 sats moved; fees ≈165 sats. Requested maximum: 54,333 sats.');
  expect(report).toContain(`Payment ID: ${receipt.paymentId}`);
  expect(report).toContain('inspect LND payments before another session.');
  expect(report).not.toContain('session..');
});
