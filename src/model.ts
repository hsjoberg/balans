export const MIN_AMOUNT = 50_000;

export interface Channel {
  id: string;
  peer: string;
  alias: string;
  capacity: number;
  local: number;
  remote: number;
  reserve: number;
  remoteReserve: number;
  active: boolean;
  pending: number;
}

export interface Peer {
  id: string;
  alias: string;
  channels: Channel[];
  capacity: number;
  local: number;
  remote: number;
  spendable: number;
  receivable: number;
}

export type Goal = 'outbound' | 'inbound';

interface PlanLimits {
  node: string;
  budget: number;
  maxFee: number;
  maxFeeRate: number;
  chunk: number;
  minutes: number;
  /** Per destination for outbound goals, per source for inbound goals. */
  maxAttemptsPerItem: number;
}

export interface OutboundPlan extends PlanLimits {
  mode: 'outbound';
  sources: { peer: string; floor: number }[];
  targets: { peer: string; minimum: number }[];
}

export interface InboundPlan extends PlanLimits {
  mode: 'inbound';
  sources: { peer: string; floor: number; minimumInbound: number }[];
  targets: { peer: string; maximum: number }[];
}

export type Plan = OutboundPlan | InboundPlan;

export interface Attempt {
  source: string;
  target: string;
  amount: number;
  maxFee: number;
  maxFeeRate: number;
  minutes: number;
  reserved: number;
}

export type Outcome =
  | { status: 'success'; moved: number; fee: number; paymentId?: string }
  | { status: 'failed'; reason: string; stop?: boolean }
  | { status: 'unknown'; reason: string; reported?: { moved: number; fee: number; paymentId?: string } };

export interface Backend {
  snapshot(): Promise<Channel[]>;
  rebalance(attempt: Attempt): Promise<Outcome>;
}

export function sats(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value.trim().replaceAll(',', ''));
  if (!match) throw new Error('Enter sats, or use k/m: 500000, 500k, 1.5m.');
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  const [whole, fraction = ''] = match[1]!.split('.');
  if (match[1]!.length > 100) throw new Error('Amount is too large.');
  const divisor = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(scale);
  if (numerator % divisor) throw new Error('Enter a non-negative whole number of sats.');
  const result = Number(numerator / divisor);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Enter a non-negative whole number of sats.');
  return result;
}

export const fmt = (n: number) => n.toLocaleString('en-US');

// Aliases are untrusted text supplied by remote Lightning nodes.
export const cleanText = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
export const cleanAlias = (s: string) => cleanText(s).slice(0, 60);

export function peers(channels: Channel[]): Peer[] {
  const result = new Map<string, Peer>();
  for (const c of channels) {
    const p = result.get(c.peer) ?? { id: c.peer, alias: cleanAlias(c.alias), channels: [], capacity: 0, local: 0, remote: 0, spendable: 0, receivable: 0 };
    p.channels.push(c);
    p.capacity += c.capacity;
    p.local += c.local;
    p.remote += c.remote;
    // Keep reserves and pending HTLCs out of our conservative estimates.
    if (c.active && !c.pending) {
      p.spendable += Math.max(0, c.local - c.reserve);
      p.receivable += Math.max(0, c.remote - c.remoteReserve);
    }
    result.set(c.peer, p);
  }
  return [...result.values()];
}

export function validatePlan(plan: Plan): void {
  if (plan.mode !== 'outbound' && plan.mode !== 'inbound') throw new Error('Choose an outbound or inbound liquidity goal.');
  for (const [key, value] of Object.entries({ budget: plan.budget, maxFee: plan.maxFee, maxFeeRate: plan.maxFeeRate, chunk: plan.chunk, minutes: plan.minutes, maxAttemptsPerItem: plan.maxAttemptsPerItem })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive safe integer.`);
  }
  if (plan.chunk < MIN_AMOUNT || plan.chunk > 4_294_967) throw new Error('Chunk size must be between 50,000 and 4,294,967 sats (BOS limits).');
  if (plan.budget < 2 || plan.maxFee < 2) throw new Error('Budget and max fee must allow at least 2 sats, including rounding.');
  if (!plan.sources.length || !plan.targets.length) throw new Error('Select at least one source and destination.');
  const ids = new Set<string>();
  const destinations = plan.mode === 'outbound' ? plan.targets.map(t => ({ peer: t.peer, value: t.minimum })) : plan.targets.map(t => ({ peer: t.peer, value: t.maximum }));
  if (plan.mode === 'inbound' && plan.sources.some(s => !Number.isSafeInteger(s.minimumInbound) || s.minimumInbound < 0)) throw new Error('Inbound targets must be non-negative safe integers.');
  for (const entry of [...plan.sources.map(s => ({ peer: s.peer, value: s.floor })), ...destinations]) {
    if (ids.has(entry.peer)) throw new Error('A peer cannot be selected twice or on both sides.');
    if (!Number.isSafeInteger(entry.value) || entry.value < 0) throw new Error('Liquidity amounts must be non-negative safe integers.');
    ids.add(entry.peer);
  }
}

export function goalProgress(plan: Plan, current: Peer[]) {
  const goals = plan.mode === 'outbound'
    ? plan.targets.map(t => ({ peer: t.peer, minimum: t.minimum }))
    : plan.sources.map(s => ({ peer: s.peer, minimum: s.minimumInbound }));
  return goals.map(goal => {
    const peer = current.find(p => p.id === goal.peer);
    const balance = peer ? (plan.mode === 'outbound' ? peer.local : peer.remote) : undefined;
    return { peer: goal.peer, remaining: balance === undefined ? Infinity : Math.max(0, goal.minimum - balance) };
  });
}

export const goalPeer = (plan: Plan, attempt: Attempt) => plan.mode === 'outbound' ? attempt.target : attempt.source;

export function nextAttempt(plan: Plan, channels: Channel[], spent: number, blocked: Set<string>, exhaustedGoals = new Set<string>()): Attempt | undefined {
  const current = peers(channels);
  const remaining = plan.budget - spent;
  // BOS exposes whole-sat fee fields. Reserve one additional sat for rounding.
  const feeCap = Math.min(plan.maxFee - 1, remaining - 1);
  if (feeCap < 1) return;
  const candidate = (source: { peer: string; floor: number }, dest: Peer, deficit: number, room = dest.receivable): Attempt | undefined => {
    const state = current.find(p => p.id === source.peer);
    if (!state || blocked.has(`${source.peer}:${dest.id}`)) return;
    const usable = Math.min(state.spendable, state.local - source.floor);
    // A final minimum-sized attempt may exceed a goal, but never a floor or cap.
    const amount = Math.min(plan.chunk, Math.max(MIN_AMOUNT, deficit), dest.receivable, room, usable - feeCap - 1);
    if (amount < MIN_AMOUNT) return;
    const maxFee = Math.min(feeCap, Number(BigInt(amount) * BigInt(plan.maxFeeRate) / 1_000_000n));
    if (maxFee < 1) return;
    return { source: source.peer, target: dest.id, amount, maxFee, maxFeeRate: plan.maxFeeRate, minutes: plan.minutes, reserved: maxFee + 1 };
  };
  if (plan.mode === 'inbound') {
    for (const source of plan.sources) {
      if (exhaustedGoals.has(source.peer)) continue;
      const state = current.find(p => p.id === source.peer);
      if (!state) continue;
      const deficit = source.minimumInbound - state.remote;
      if (deficit <= 0) continue;
      const receivers = plan.targets.map(t => {
        const dest = current.find(p => p.id === t.peer);
        return { dest, room: dest ? Math.min(dest.receivable, t.maximum - dest.local) : 0 };
      }).sort((a, b) => b.room - a.room);
      for (const { dest, room } of receivers) {
        if (!dest) continue;
        const attempt = candidate(source, dest, deficit, room);
        if (attempt) return attempt;
      }
    }
    return;
  }
  for (const target of plan.targets) {
    if (exhaustedGoals.has(target.peer)) continue;
    const dest = current.find(p => p.id === target.peer);
    if (!dest) continue;
    const deficit = target.minimum - dest.local;
    if (deficit <= 0) continue;
    const sources = plan.sources.map(s => ({ ...s, state: current.find(p => p.id === s.peer) }))
      .sort((a, b) => ((b.state?.local ?? 0) - b.floor) - ((a.state?.local ?? 0) - a.floor));
    for (const source of sources) {
      const attempt = candidate(source, dest, deficit);
      if (attempt) return attempt;
    }
  }
}
