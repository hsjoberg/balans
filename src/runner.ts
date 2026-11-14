import { goalPeer, goalProgress, nextAttempt, peers, validatePlan, type Backend, type Channel, type Plan, type Attempt, type Outcome } from './model.ts';

export type Event =
  | { type: 'reserved'; attempt: Attempt; spent: number }
  | { type: 'result'; attempt: Attempt; outcome: Outcome; spent: number };

export interface SessionSummary {
  spent: number;
  moved: number;
  attempts: number;
  reason: string;
  results: { attempt: Attempt; outcome: Outcome }[];
  before?: Channel[];
  after?: Channel[];
  balanceReadFailed: boolean;
}

// Journal callbacks must persist the reservation before we invoke the backend.
export async function runSession(plan: Plan, backend: Backend, record: (event: Event) => void, shouldStop = () => false): Promise<SessionSummary> {
  validatePlan(plan);
  let spent = 0;
  let moved = 0;
  let attempts = 0;
  let reason = '';
  const attemptsByGoal = new Map<string, number>();
  const blocked = new Set<string>();
  const selected = new Set([...plan.sources, ...plan.targets].map(p => p.peer));
  const selectedSnapshot = (channels: Channel[]) => structuredClone(channels.filter(c => selected.has(c.peer)));
  const results: SessionSummary['results'] = [];
  let before: Channel[] | undefined;
  let after: Channel[] | undefined;
  let balanceReadFailed = false;
  while (true) {
    if (shouldStop()) { reason = 'stopped by operator'; break; }
    let channels: Channel[];
    try { channels = await backend.snapshot(); }
    catch {
      balanceReadFailed = true;
      after = undefined;
      reason = 'could not refresh channel balances';
      break;
    }
    before ??= selectedSnapshot(channels);
    after = selectedSnapshot(channels);
    if (shouldStop()) { reason = 'stopped by operator'; break; }
    const exhaustedGoals = new Set([...attemptsByGoal].filter(([, count]) => count >= plan.maxAttemptsPerItem).map(([peer]) => peer));
    const attempt = nextAttempt(plan, channels, spent, blocked, exhaustedGoals);
    if (!attempt) {
      const progress = goalProgress(plan, peers(channels));
      reason = progress.every(g => g.remaining === 0) ? 'targets reached'
        : plan.budget - spent < 2 ? 'fee budget exhausted'
        : progress.some(g => g.remaining > 0 && exhaustedGoals.has(g.peer))
          ? `no eligible pair remaining (${plan.mode === 'outbound' ? 'destination' : 'source'} attempt limits reached or routes/liquidity exhausted)`
        : 'no eligible pair (insufficient available liquidity, fee allowance, or exhausted routes)';
      break;
    }
    record({ type: 'reserved', attempt, spent: spent + attempt.reserved });
    spent += attempt.reserved;
    attempts++;
    const item = goalPeer(plan, attempt);
    attemptsByGoal.set(item, (attemptsByGoal.get(item) ?? 0) + 1);
    // Never present a pre-attempt snapshot as the final observed balance.
    after = undefined;
    let outcome: Outcome;
    try { outcome = await backend.rebalance(attempt); }
    catch { outcome = { status: 'unknown', reason: 'Backend disconnected or returned an unreadable response.' }; }
    if (outcome.status === 'success') {
      if (!Number.isSafeInteger(outcome.fee) || outcome.fee < 0 || outcome.fee > attempt.reserved || !Number.isSafeInteger(outcome.moved) || outcome.moved <= 0 || outcome.moved > attempt.amount) {
        const reported = Number.isSafeInteger(outcome.moved) && outcome.moved > 0 && Number.isSafeInteger(outcome.fee) && outcome.fee >= 0 ? { moved: outcome.moved, fee: outcome.fee, ...(outcome.paymentId ? { paymentId: outcome.paymentId } : {}) } : undefined;
        // Keep the receipt for reconciliation, and never reserve less than its
        // reported fee when a backend result violates our limits.
        if (reported) spent += Math.max(0, reported.fee - attempt.reserved);
        outcome = { status: 'unknown', reason: 'BOS returned an unexpected amount or fee; inspect LND payments before another session.', reported };
      } else {
        spent += outcome.fee - attempt.reserved;
        moved += outcome.moved;
      }
    } else if (outcome.status === 'failed') {
      spent -= attempt.reserved;
      blocked.add(`${attempt.source}:${attempt.target}`);
    }
    record({ type: 'result', attempt, outcome, spent });
    results.push({ attempt, outcome });
    if (outcome.status === 'unknown') { reason = `unresolved payment: ${outcome.reason}`; break; }
    if (outcome.status === 'failed' && outcome.stop) { reason = `stopped before payment: ${outcome.reason}`; break; }
  }
  // The next loop read normally provides the final snapshot. Refresh once here
  // when stopping immediately after an attempt (failure, cancellation or ambiguity).
  if (before && !after && !balanceReadFailed) {
    try { after = selectedSnapshot(await backend.snapshot()); }
    catch { balanceReadFailed = true; }
  }
  return { spent, moved, attempts, reason, results, before, after, balanceReadFailed };
}
