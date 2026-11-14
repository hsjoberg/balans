import { describe, expect, test } from 'bun:test';
import { decodeChannels, decodeRebalance } from '../src/bos.ts';
import { demoBackend } from '../src/demo.ts';
import { cleanAlias, nextAttempt, peers, sats, validatePlan, type Backend, type Channel, type OutboundPlan } from '../src/model.ts';
import { runSession, type Event } from '../src/runner.ts';
import { checkSessionLock, openJournal } from '../src/journal.ts';
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const channel = (peer: string, local: number, extra: Partial<Channel> = {}): Channel => ({ id: peer, peer, alias: peer, local, capacity: 10_000_000, remote: 10_000_000 - local, reserve: 10_000, remoteReserve: 10_000, active: true, pending: 0, ...extra });
const snapshot = () => [channel('source', 5_000_000), channel('target', 0)];
const plan = (extra: Partial<OutboundPlan> = {}): OutboundPlan => ({ mode: 'outbound', node: 'test', sources: [{ peer: 'source', floor: 1_000_000 }], targets: [{ peer: 'target', minimum: 1_000_000 }], budget: 5_000, maxFee: 1_000, maxFeeRate: 5_500, chunk: 500_000, minutes: 5, maxAttemptsPerItem: 10, ...extra });

describe('liquidity planning', () => {
  test('protects source floors including maximum fees', () => {
    const channels = [channel('source', 1_200_000), channel('target', 0)];
    const a = nextAttempt(plan(), channels, 0, new Set())!;
    expect(a.amount + a.reserved).toBeLessThanOrEqual(200_000);
  });
  test('reserves fit both the fee cap and remaining budget', () => {
    const a = nextAttempt(plan(), snapshot(), 4_700, new Set())!;
    expect(a.reserved).toBeLessThanOrEqual(300);
    expect(a.reserved).toBeLessThanOrEqual(1_000);
    expect(nextAttempt(plan(), snapshot(), 4_999, new Set())).toBeUndefined();
  });
  test('limits each amount to destination shortfall and remote liquidity', () => {
    const a = nextAttempt(plan(), [channel('source', 5_000_000), channel('target', 800_000, { remote: 120_000 })], 0, new Set())!;
    expect(a.amount).toBe(110_000);
  });
  test('ignores inactive and unsettled source channels', () => {
    for (const extra of [{ active: false }, { pending: 1 }]) {
      expect(nextAttempt(plan(), [channel('source', 5_000_000, extra), channel('target', 0)], 0, new Set())).toBeUndefined();
    }
  });
  test('groups duplicate peers and sums their targets without duplicating selection', () => {
    const p = peers([channel('target', 100_000), channel('target', 200_000, { id: 'second' })])[0]!;
    expect(p.local).toBe(300_000);
    expect(p.channels.length).toBe(2);
  });
  test('uses a minimum-sized final attempt for small deficits, but skips met targets', () => {
    for (const local of [950_001, 956_270, 980_000, 999_999]) {
      const attempt = nextAttempt(plan(), [channel('source', 5_000_000), channel('target', local)], 0, new Set())!;
      expect(attempt.amount).toBe(50_000);
      expect(local + attempt.amount - 1_000_000).toBeLessThanOrEqual(49_999);
      expect(attempt.reserved).toBeLessThanOrEqual(plan().maxFee);
    }
    for (const local of [1_000_000, 1_200_000]) expect(nextAttempt(plan(), [channel('source', 5_000_000), channel('target', local)], 0, new Set())).toBeUndefined();
  });
  test('final top-ups still require sufficient source balance, inbound liquidity, and budget', () => {
    const dest = channel('target', 980_000);
    expect(nextAttempt(plan(), [channel('source', 1_040_000), dest], 0, new Set())).toBeUndefined();
    expect(nextAttempt(plan(), [channel('source', 5_000_000), { ...dest, remote: 59_999 }], 0, new Set())).toBeUndefined();
    expect(nextAttempt(plan(), [channel('source', 5_000_000), dest], 4_999, new Set())).toBeUndefined();
  });
  test('does not reuse a blocked pair', () => {
    expect(nextAttempt(plan(), snapshot(), 0, new Set(['source:target']))).toBeUndefined();
  });
  test('rejects overlapping peers and invalid limits', () => {
    expect(() => validatePlan(plan({ sources: [{ peer: 'target', floor: 0 }] }))).toThrow();
    expect(() => validatePlan(plan({ budget: -1 }))).toThrow();
    expect(() => validatePlan(plan({ chunk: 49_999 }))).toThrow();
  });
});

describe('session accounting', () => {
  test('finishes the reported live shortfall after two partial rebalances', async () => {
    const channels = [channel('source', 5_000_000), channel('target', 101_745)];
    const amounts: number[] = [];
    const movedAmounts = [454_813, 399_712, 50_000];
    const fees = [520, 696, 101];
    const backend: Backend = {
      snapshot: async () => structuredClone(channels),
      rebalance: async attempt => {
        const index = amounts.length;
        amounts.push(attempt.amount);
        const moved = movedAmounts[index]!;
        const fee = fees[index]!;
        channels[0]!.local -= moved + fee;
        channels[0]!.remote += moved + fee;
        channels[1]!.local += moved;
        channels[1]!.remote -= moved;
        return { status: 'success', moved, fee };
      },
    };
    const result = await runSession(plan({ budget: 15_000, maxFee: 5_000 }), backend, () => {});
    expect(amounts).toEqual([500_000, 443_442, 50_000]);
    expect(result.reason).toBe('targets reached');
    expect(result.attempts).toBe(3);
    expect(result.spent).toBe(1_317);
    expect(channels[1]!.local).toBe(1_006_270);
    expect(channels[0]!.local).toBeGreaterThanOrEqual(1_000_000);
  });
  test('never starts an attempt without a persisted reservation', async () => {
    let invoked = false;
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async () => { invoked = true; throw new Error(); } };
    await expect(runSession(plan(), backend, () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(invoked).toBe(false);
  });
  test('refreshes liquidity and finishes at the target', async () => {
    const channels = snapshot();
    let reads = 0;
    const events: Event[] = [];
    const backend: Backend = {
      snapshot: async () => { reads++; return structuredClone(channels); },
      rebalance: async a => {
        expect(events.at(-1)?.type).toBe('reserved');
        channels[0]!.local -= a.amount + 100;
        channels[1]!.local += a.amount;
        return { status: 'success', moved: a.amount, fee: 100 };
      },
    };
    const result = await runSession(plan(), backend, e => events.push(e));
    expect(result.moved).toBe(1_000_000);
    expect(result.spent).toBe(200);
    expect(result.attempts).toBe(2);
    expect(reads).toBe(3);
    expect(result.reason).toBe('targets reached');
  });
  test('charges successful partial amounts and stays within budget', async () => {
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async a => ({ status: 'success', moved: 100_000, fee: a.reserved }) };
    const result = await runSession(plan({ budget: 1_500 }), backend, () => {});
    expect(result.spent).toBe(1_500);
    expect(result.attempts).toBe(2);
    expect(result.moved).toBe(200_000);
  });
  test('releases budget only for a definitive prepayment failure and tries another source', async () => {
    const used: string[] = [];
    const backend: Backend = {
      snapshot: async () => [...snapshot(), channel('second', 4_000_000)],
      rebalance: async a => { used.push(a.source); return { status: 'failed', reason: 'No route' }; },
    };
    const result = await runSession(plan({ sources: [{ peer: 'source', floor: 0 }, { peer: 'second', floor: 0 }] }), backend, () => {});
    expect(result.spent).toBe(0);
    expect(used).toEqual(['source', 'second']);
  });
  test('stops and retains the reservation on a lost payment outcome', async () => {
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async () => { throw new Error('connection lost'); } };
    const result = await runSession(plan(), backend, () => {});
    expect(result.attempts).toBe(1);
    expect(result.spent).toBe(1_000);
    expect(result.reason).toContain('unresolved payment');
  });
  test('a probe fee change releases its budget and another source can complete the target', async () => {
    const channels = [...snapshot(), channel('second', 4_000_000)];
    const used: string[] = [];
    const events: Event[] = [];
    const backend: Backend = {
      snapshot: async () => structuredClone(channels),
      rebalance: async a => {
        used.push(a.source);
        if (a.source === 'source') return decodeRebalance({ ok: false, reason: 'FeeIncreasedOnChannel' });
        channels[2]!.local -= a.amount + 100;
        channels[1]!.local += a.amount;
        return { status: 'success', moved: a.amount, fee: 100 };
      },
    };
    const result = await runSession(plan({ sources: [{ peer: 'source', floor: 0 }, { peer: 'second', floor: 0 }], targets: [{ peer: 'target', minimum: 500_000 }] }), backend, event => events.push(event));
    expect(used).toEqual(['source', 'second']);
    expect(events[1]).toMatchObject({ type: 'result', spent: 0, outcome: { status: 'failed' } });
    expect(result.spent).toBe(100);
    expect(result.moved).toBe(500_000);
    expect(result.reason).toBe('targets reached');
  });
  test('invoice creation failure stops without trying other sources or destinations and releases its lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balans-test-'));
    const journal = openJournal('invoice-failure', directory);
    let uncertain = false;
    try {
      const calls: string[] = [];
      const events: Event[] = [];
      const channels = [...snapshot(), channel('second', 4_000_000), channel('later', 0)];
      const backend: Backend = {
        snapshot: async () => structuredClone(channels),
        rebalance: async a => {
          calls.push(`${a.source}:${a.target}`);
          if (calls.length === 3) return decodeRebalance({ ok: false, reason: 'AddInvoiceError', diagnostics: { rpcStatus: 'INVALID_ARGUMENT' } });
          channels[0]!.local -= 100_100;
          channels[1]!.local += 100_000;
          return { status: 'success', moved: 100_000, fee: 100 };
        },
      };
      const summary = await runSession(plan({ sources: [{ peer: 'source', floor: 0 }, { peer: 'second', floor: 0 }], targets: [{ peer: 'target', minimum: 1_000_000 }, { peer: 'later', minimum: 1_000_000 }] }), backend, event => {
        journal.write(event);
        events.push(event);
        uncertain = event.type === 'reserved' || event.outcome.status === 'unknown';
      });
      expect(calls).toEqual(['source:target', 'source:target', 'source:target']);
      expect(summary.reason).toBe('stopped before payment: AddInvoiceError (INVALID_ARGUMENT)');
      expect(summary.spent).toBe(200);
      expect(summary.moved).toBe(200_000);
      expect(summary.after?.find(c => c.peer === 'target')?.local).toBe(200_000);
      expect(events.at(-1)).toMatchObject({ type: 'result', spent: 200, outcome: { status: 'failed', stop: true } });
      expect(uncertain).toBe(false);
      journal.close(uncertain);
      checkSessionLock('invoice-failure', directory);
    } finally {
      journal.close(uncertain);
      for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
      rmdirSync(directory);
    }
  });
  test('treats malformed successful amounts as unresolved', async () => {
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async () => ({ status: 'success', moved: NaN, fee: 1 }) };
    const result = await runSession(plan(), backend, () => {});
    expect(result.reason).toContain('unresolved payment');
    expect(result.spent).toBe(1_000);
  });
  test('stops after current attempt when operator requests cancellation', async () => {
    let stopping = false;
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async () => { stopping = true; return { status: 'success', moved: 100_000, fee: 100 }; } };
    const result = await runSession(plan(), backend, () => {}, () => stopping);
    expect(result.attempts).toBe(1);
    expect(result.reason).toBe('stopped by operator');
  });
  test('bounds attempts even if external activity prevents reaching a target', async () => {
    const backend: Backend = { snapshot: async () => snapshot(), rebalance: async () => ({ status: 'success', moved: 100_000, fee: 1 }) };
    const result = await runSession(plan({ maxAttemptsPerItem: 3 }), backend, () => {});
    expect(result.attempts).toBe(3);
    expect(result.reason).toContain('destination attempt limits reached');
  });
  test('each destination gets its own 20 attempts, even when earlier targets stay short', async () => {
    const used: string[] = [];
    const backend: Backend = {
      // Simulate ongoing forwarding keeping both balances below their targets.
      snapshot: async () => [...snapshot(), channel('later', 0)],
      rebalance: async a => { used.push(a.target); return { status: 'success', moved: 50_000, fee: 1 }; },
    };
    const result = await runSession(plan({ maxAttemptsPerItem: 20, targets: [{ peer: 'target', minimum: 1_000_000 }, { peer: 'later', minimum: 1_000_000 }] }), backend, () => {});
    expect(used).toEqual([...Array(20).fill('target'), ...Array(20).fill('later')]);
    expect(result.attempts).toBe(40);
    expect(result.spent).toBe(40);
    expect(result.reason).toContain('destination attempt limits reached');
  });
  test('source changes share one destination limit and the next destination starts fresh', async () => {
    const used: string[] = [];
    const backend: Backend = {
      snapshot: async () => [...snapshot(), channel('second', 4_000_000), channel('later', 0)],
      rebalance: async a => {
        used.push(`${a.source}:${a.target}`);
        return a.source === 'source' ? { status: 'failed', reason: 'No route' } : { status: 'success', moved: 50_000, fee: 1 };
      },
    };
    const result = await runSession(plan({ maxAttemptsPerItem: 2, sources: [{ peer: 'source', floor: 0 }, { peer: 'second', floor: 0 }], targets: [{ peer: 'target', minimum: 1_000_000 }, { peer: 'later', minimum: 1_000_000 }] }), backend, () => {});
    expect(used).toEqual(['source:target', 'second:target', 'source:later', 'second:later']);
    expect(result.attempts).toBe(4);
    expect(result.spent).toBe(2);
  });
  test('the fee budget remains global across destination attempt limits', async () => {
    const used: string[] = [];
    const backend: Backend = {
      snapshot: async () => [...snapshot(), channel('later', 0)],
      rebalance: async a => { used.push(a.target); return { status: 'success', moved: 50_000, fee: a.reserved }; },
    };
    const result = await runSession(plan({ budget: 1_500, maxAttemptsPerItem: 1, targets: [{ peer: 'target', minimum: 1_000_000 }, { peer: 'later', minimum: 1_000_000 }] }), backend, () => {});
    expect(used).toEqual(['target', 'later']);
    expect(result.spent).toBe(1_500);
    expect(result.reason).toBe('fee budget exhausted');
  });
  test('demo runs without BOS and preserves the source floor', async () => {
    const backend = demoBackend();
    const current = peers(await backend.snapshot());
    const result = await runSession(plan({ sources: [{ peer: current[0]!.id, floor: 8_500_000 }], targets: [{ peer: current[1]!.id, minimum: 1_000_000 }] }), backend, () => {});
    expect(result.moved).toBeGreaterThan(0);
    expect(peers(await backend.snapshot())[0]!.local).toBeGreaterThanOrEqual(8_500_000);
  });
});

describe('BOS contract and input', () => {
  test('decodes total sent into principal and a conservative fee ceiling', () => {
    expect(decodeRebalance({ ok: true, result: { rebalance: [{}, {}, { rebalanced: '0.00501000', rebalance_fees_spent: '0.00001000' }] } })).toEqual({ status: 'success', moved: 500_000, fee: 1_001 });
    expect(decodeRebalance({ ok: true, result: { rebalance: [{ rebalanced: '0.00500000' }] } })).toEqual({ status: 'success', moved: 500_000, fee: 1 });
  });
  test('distinguishes prepayment errors from potentially paid failures', () => {
    expect(decodeRebalance({ ok: false, reason: 'RebalanceFeeRateTooHigh' }).status).toBe('failed');
    expect(decodeRebalance({ ok: false, reason: 'UnexpectedErrExecutingRebalance' }).status).toBe('unknown');
    expect(decodeRebalance({ ok: false, reason: 'SomethingNew' }).status).toBe('unknown');
    expect(() => decodeRebalance({ ok: true, result: {} })).toThrow();
  });
  test('validates channel responses instead of planning with missing reserves', () => {
    expect(decodeChannels(snapshot())).toEqual(snapshot());
    expect(() => decodeChannels([{ ...channel('a', 100), reserve: undefined }])).toThrow();
  });
  test('accepts sats and shorthand, rejects unsafe amounts', () => {
    expect(sats('1.5m')).toBe(1_500_000);
    expect(sats('1.001m')).toBe(1_001_000);
    expect(sats('500k')).toBe(500_000);
    expect(sats('1,000,000')).toBe(1_000_000);
    for (const bad of ['-1', 'Infinity', '1e6', '0.1', '9007199254740992', '1; echo test']) expect(() => sats(bad)).toThrow();
  });
  test('strips terminal controls from peer aliases', () => {
    expect(cleanAlias('peer\u001b\n\u202etest')).toBe('peertest');
  });
  test('reports worker validation errors without connecting to a node', async () => {
    const child = Bun.spawn([process.execPath, 'src/bos-worker.cjs'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ action: 'invalid' }));
    child.stdin.end();
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, reason: 'UnknownWorkerAction', diagnostics: { stage: 'request parsing', errorType: 'Error' } });
  });
  test('loads the pinned BOS dependency under Bun without Node on PATH', async () => {
    const child = Bun.spawn([process.execPath, '-e', "if(!process.versions.bun || typeof require('balanceofsatoshis/lnd/authenticated_lnd') !== 'function' || typeof require('balanceofsatoshis/swaps/rebalance') !== 'function') process.exit(1);"], { env: { ...process.env, PATH: '' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
  });
  test('unexpected worker exceptions report context without leaking their message', () => {
    const { workerFailure } = require('../src/bos-worker-errors.cjs');
    const error = new SyntaxError('Invalid credentials: macaroon=super-secret-value');
    const failure = workerFailure(error, 'loading credentials and connecting to LND', '1.4.4');
    expect(failure).toMatchObject({ ok: false, reason: 'BosWorkerError', diagnostics: { errorType: 'SyntaxError', bunVersion: '1.4.4' } });
    expect(JSON.stringify(failure)).not.toContain('super-secret-value');
  });
  test('nested invoice errors expose RPC status without arbitrary server details', () => {
    const { workerFailure } = require('../src/bos-worker-errors.cjs');
    const error = [503, 'AddInvoiceError', { err: { code: 7, details: 'macaroon=super-secret-value', message: 'another-secret' } }];
    const failure = workerFailure(error, 'executing BOS rebalance');
    expect(failure.diagnostics.rpcStatus).toBe('PERMISSION_DENIED');
    expect(decodeRebalance(failure)).toEqual({ status: 'failed', reason: 'AddInvoiceError (PERMISSION_DENIED)', stop: true });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
});

describe('durable session journal', () => {
  test('writes ordered records, excludes a second writer, and retains unresolved locks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balans-test-'));
    try {
      checkSessionLock('fake-node', join(directory, 'not-created'));
      checkSessionLock('fake-node', directory);
      expect(readdirSync(directory)).toEqual([]);
      const journal = openJournal('fake-node', directory);
      journal.write({ type: 'plan' });
      journal.write({ type: 'reserved', spent: 1_000 });
      expect(() => checkSessionLock('fake-node', directory)).toThrow('A session lock exists:');
      expect(() => openJournal('fake-node', directory)).toThrow('session lock');
      const records = readFileSync(journal.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.map(r => r.type)).toEqual(['plan', 'reserved']);
      journal.close(true);
      const lock = join(directory, readdirSync(directory).find(name => name.endsWith('.lock'))!);
      const originalLock = readFileSync(lock, 'utf8');
      expect(() => checkSessionLock('fake-node', directory)).toThrow(lock);
      expect(readFileSync(lock, 'utf8')).toBe(originalLock);
      expect(() => openJournal('fake-node', directory)).toThrow('session lock');
      checkSessionLock('another-node', directory);
      const other = openJournal('another-node', directory);
      other.close();
      checkSessionLock('another-node', directory);
      expect(readdirSync(directory).filter(name => name.endsWith('.lock')).length).toBe(1);
    } finally {
      // Only exact files directly inside this test's freshly created temp directory.
      for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
      rmdirSync(directory);
    }
  });
});
