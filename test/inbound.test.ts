import { describe, expect, test } from 'bun:test';
import { demoBackend } from '../src/demo.ts';
import { goalProgress, nextAttempt, peers, validatePlan, type Backend, type Channel, type InboundPlan } from '../src/model.ts';
import { runSession } from '../src/runner.ts';
import { formatSessionReport } from '../src/session-report.ts';

const channel = (peer: string, local: number, remote: number, extra: Partial<Channel> = {}): Channel => ({
  id: peer, peer, alias: peer, local, remote, capacity: 10_000_000, reserve: 10_000, remoteReserve: 10_000, active: true, pending: 0, ...extra,
});
const channels = () => [channel('source', 9_000_000, 950_000), channel('receiver', 1_000_000, 8_900_000)];
const plan = (extra: Partial<InboundPlan> = {}): InboundPlan => ({
  mode: 'inbound', node: 'demo', sources: [{ peer: 'source', floor: 1_000_000, minimumInbound: 2_000_000 }],
  targets: [{ peer: 'receiver', maximum: 5_000_000 }], budget: 15_000, maxFee: 5_000, maxFeeRate: 5_000,
  chunk: 500_000, minutes: 5, maxAttemptsPerItem: 20, ...extra,
});

describe('inbound goals', () => {
  test('uses observed remote balances, including across parallel channels, rather than capacity minus local', () => {
    const current = peers([...channels(), channel('source', 100_000, 200_000, { id: 'parallel' })]);
    expect(current.find(p => p.id === 'source')?.remote).toBe(1_150_000);
    expect(goalProgress(plan(), current)).toEqual([{ peer: 'source', remaining: 850_000 }]);
  });
  test('plans from the source inbound shortfall and skips goals already met', () => {
    const p = plan({ sources: [{ peer: 'source', floor: 1_000_000, minimumInbound: 1_100_000 }] });
    expect(nextAttempt(p, channels(), 0, new Set())?.amount).toBe(150_000);
    expect(nextAttempt(p, [channel('source', 8_000_000, 1_100_000), channels()[1]!], 0, new Set())).toBeUndefined();
  });
  test('bounds receiving amounts by destination caps, even for a minimum-sized top-up', () => {
    const p = plan({ targets: [{ peer: 'receiver', maximum: 1_080_000 }] });
    expect(nextAttempt(p, channels(), 0, new Set())?.amount).toBe(80_000);
    p.targets[0]!.maximum = 1_049_999;
    expect(nextAttempt(p, channels(), 0, new Set())).toBeUndefined();
    p.targets[0]!.maximum = 900_000;
    expect(nextAttempt(p, channels(), 0, new Set())).toBeUndefined();
  });
  test('small inbound shortfalls use the minimum amount while protecting the source floor and fees', () => {
    const p = plan({ sources: [{ peer: 'source', floor: 8_940_000, minimumInbound: 951_000 }] });
    const attempt = nextAttempt(p, channels(), 0, new Set())!;
    expect(attempt.amount).toBe(50_000);
    expect(attempt.amount + attempt.reserved).toBeLessThanOrEqual(60_000);
    p.sources[0]!.floor = 8_950_000;
    expect(nextAttempt(p, channels(), 0, new Set())).toBeUndefined();
  });
  test('pending, inactive, reserved, blocked, and exhausted channels cannot fund or receive attempts', () => {
    for (const extra of [{ active: false }, { pending: 1 }]) {
      expect(nextAttempt(plan(), [{ ...channels()[0]!, ...extra }, channels()[1]!], 0, new Set())).toBeUndefined();
      expect(nextAttempt(plan(), [channels()[0]!, { ...channels()[1]!, ...extra }], 0, new Set())).toBeUndefined();
    }
    expect(nextAttempt(plan(), [channels()[0]!, channel('receiver', 1_000_000, 59_999)], 0, new Set())).toBeUndefined();
    expect(nextAttempt(plan(), channels(), 0, new Set(['source:receiver']))).toBeUndefined();
    expect(nextAttempt(plan(), channels(), 0, new Set(), new Set(['source']))).toBeUndefined();
  });
  test('rejects invalid inbound goals and receiver caps', () => {
    expect(() => validatePlan(plan({ sources: [{ peer: 'source', floor: 0, minimumInbound: NaN }] }))).toThrow();
    expect(() => validatePlan(plan({ targets: [{ peer: 'receiver', maximum: -1 }] }))).toThrow();
    expect(() => validatePlan(plan({ targets: [{ peer: 'source', maximum: 2_000_000 }] }))).toThrow();
  });
  test('20 attempts follow each source across receiving peers, then move to the next source', async () => {
    const used: string[] = [];
    const p = plan({ sources: [{ peer: 'source', floor: 0, minimumInbound: 2_000_000 }, { peer: 'second', floor: 0, minimumInbound: 2_000_000 }], targets: [{ peer: 'receiver', maximum: 5_000_000 }, { peer: 'alternate', maximum: 2_000_000 }] });
    const backend: Backend = {
      // Forwarding keeps source goals below their targets during this test.
      snapshot: async () => [...channels(), channel('second', 9_000_000, 950_000), channel('alternate', 0, 9_000_000)],
      rebalance: async a => {
        used.push(`${a.source}:${a.target}`);
        return a.target === 'receiver' ? { status: 'failed', reason: 'No route' } : { status: 'success', moved: 50_000, fee: 1 };
      },
    };
    const summary = await runSession(p, backend, () => {});
    expect(used).toEqual(['source:receiver', ...Array(19).fill('source:alternate'), 'second:receiver', ...Array(19).fill('second:alternate')]);
    expect(summary.attempts).toBe(40);
    expect(summary.spent).toBe(38);
    expect(summary.reason).toContain('source attempt limits reached');
    expect(formatSessionReport(p, summary)).toContain('Attempt limit reached: 20 / 20 for this source.');
  });
  test('the global budget and unresolved-payment stop still apply to inbound goals', async () => {
    const p = plan({ budget: 500, maxFee: 500 });
    const summary = await runSession(p, { snapshot: async () => channels(), rebalance: async a => ({ status: 'success', moved: a.amount, fee: a.reserved }) }, () => {});
    expect(summary.spent).toBe(500);
    expect(summary.attempts).toBe(1);
    expect(summary.reason).toBe('fee budget exhausted');
    const unknown = await runSession(p, { snapshot: async () => channels(), rebalance: async () => ({ status: 'unknown', reason: 'disconnected' }) }, () => {});
    expect(unknown.spent).toBe(500);
    expect(unknown.attempts).toBe(1);
    expect(unknown.reason).toContain('unresolved payment');
  });
  test('the demo reaches an inbound goal and reports actual inbound changes and receiver caps', async () => {
    const backend = demoBackend();
    const p = plan({ sources: [{ peer: 'demo-amber-bridge', floor: 1_000_000, minimumInbound: 1_000_000 }], targets: [{ peer: 'demo-paper-lantern', maximum: 2_000_000 }] });
    const summary = await runSession(p, backend, () => {});
    const final = peers(summary.after!);
    expect(summary.reason).toBe('targets reached');
    expect(final.find(c => c.id === 'demo-amber-bridge')!.remote).toBeGreaterThanOrEqual(1_000_000);
    expect(final.find(c => c.id === 'demo-amber-bridge')!.local).toBeGreaterThanOrEqual(1_000_000);
    expect(final.find(c => c.id === 'demo-paper-lantern')!.local).toBeLessThanOrEqual(2_000_000);
    const report = formatSessionReport(p, summary);
    expect(report).toContain('Inbound target minimum: 1,000,000 sats · met');
    expect(report).toContain('Maximum outbound: 2,000,000 sats · within limit');
    expect(report).toContain('Inbound: 0 →');
    expect(report).not.toContain('unverified');
  });
  test('inbound reports leave missing final balances unverified', async () => {
    let reads = 0;
    const p = plan();
    const summary = await runSession(p, {
      snapshot: async () => { if (++reads > 1) throw new Error('offline'); return channels(); },
      rebalance: async () => ({ status: 'failed', reason: 'invoice error', stop: true }),
    }, () => {});
    const report = formatSessionReport(p, summary);
    expect(report).toContain('Inbound target minimum: 2,000,000 sats · unverified');
    expect(report).toContain('Maximum outbound: 5,000,000 sats · unverified');
  });
});
