import { cleanAlias, cleanText, fmt, goalPeer, goalProgress, peers, type Plan } from './model.ts';
import type { SessionSummary } from './runner.ts';

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

export function formatSessionReport(plan: Plan, summary: SessionSummary, fallbackName: (peer: string) => string = peer => peer): string {
  const observed = [...(summary.after ?? []), ...(summary.before ?? [])];
  const name = (peer: string) => cleanAlias(observed.find(c => c.peer === peer)?.alias ?? fallbackName(peer));
  const succeeded = summary.results.filter(r => r.outcome.status === 'success');
  const failed = summary.results.filter(r => r.outcome.status === 'failed');
  const unresolved = summary.results.filter(r => r.outcome.status === 'unknown');
  const fees = succeeded.reduce((sum, r) => sum + (r.outcome.status === 'success' ? r.outcome.fee : 0), 0);
  const lines = [
    `\nSession ended: ${cleanText(summary.reason).replace(/[.!]+$/, '')}.`,
    `${succeeded.length} succeeded · ${failed.length} failed${unresolved.length ? ` · ${unresolved.length} unresolved` : ''} · ${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'}`,
    `${unresolved.length ? 'Confirmed moved' : 'Moved'}: ${fmt(summary.moved)} sats · ${unresolved.length ? 'Confirmed fees' : 'Fees'}: ≈${fmt(fees)} sats`,
    `Budget remaining: ${fmt(Math.max(0, plan.budget - summary.spent))} / ${fmt(plan.budget)} sats`,
  ];
  if (unresolved.length) lines.push(`Reserved for unresolved payments: ${fmt(summary.spent - fees)} sats`);
  lines.push('\nRebalance attempts');
  if (!summary.results.length) lines.push('  No rebalances submitted.');
  summary.results.forEach(({ attempt, outcome }, index) => {
    lines.push(`  ${index + 1}. ${name(attempt.source)} → ${name(attempt.target)}`);
    if (outcome.status === 'success') lines.push(`     Moved ${fmt(outcome.moved)} sats · Fees ≈${fmt(outcome.fee)} sats`);
    else if (outcome.status === 'failed') lines.push(`     Failed before payment${outcome.stop ? ' · session stopped' : ''}: ${cleanText(outcome.reason)}`);
    else {
      lines.push(`     Unresolved payment: ${cleanText(outcome.reason)}`);
      if (outcome.reported) lines.push(`     BOS reported ${fmt(outcome.reported.moved)} sats moved; fees ≈${fmt(outcome.reported.fee)} sats. Requested maximum: ${fmt(attempt.amount)} sats.`);
      if (outcome.reported?.paymentId) lines.push(`     Payment ID: ${cleanText(outcome.reported.paymentId)}`);
    }
  });

  lines.push(`\nObserved channel balances · ${plan.mode === 'inbound' ? 'outbound and inbound' : 'outbound'} sats`);
  if (summary.balanceReadFailed) lines.push('  Final balances unavailable: the channel read failed.');
  if (!summary.before) lines.push('  No starting balance snapshot is available.');
  const finalPeers = summary.after ? peers(summary.after) : undefined;
  const progress = finalPeers ? goalProgress(plan, finalPeers) : [];
  const minimumStatus = (label: string, minimum: number, balance: number | undefined) => {
    const status = balance === undefined ? 'unverified' : balance >= minimum ? 'met' : `${fmt(minimum - balance)} sats short`;
    lines.push(`    ${label}: ${fmt(minimum)} sats · ${status}`);
  };
  const roles = [
    ...plan.sources.map(s => ({ peer: s.peer, role: 'source' })),
    ...plan.targets.map(t => ({ peer: t.peer, role: 'destination' })),
  ];
  for (const { peer, role } of roles) {
    const before = (summary.before ?? []).filter(c => c.peer === peer);
    const after = (summary.after ?? []).filter(c => c.peer === peer);
    const ids = [...new Set([...before, ...after].map(c => c.id))];
    lines.push(`  ${name(peer)} · ${role}${ids.length > 1 ? ` · ${ids.length} channels` : ''}`);
    if (!ids.length) lines.push('    Channel balances unavailable.');
    for (const id of ids) {
      const start = before.find(c => c.id === id);
      const end = after.find(c => c.id === id);
      const delta = start && end ? ` (${signed(end.local - start.local)})` : '';
      lines.push(`    ${cleanAlias(id)}: ${start ? fmt(start.local) : 'unavailable'} → ${end ? fmt(end.local) : 'unavailable'}${delta}`);
      if (plan.mode === 'inbound') {
        const inboundDelta = start && end ? ` (${signed(end.remote - start.remote)})` : '';
        lines.push(`      Inbound: ${start ? fmt(start.remote) : 'unavailable'} → ${end ? fmt(end.remote) : 'unavailable'}${inboundDelta}`);
      }
    }
    const current = finalPeers?.find(p => p.id === peer);
    if (role === 'source') {
      minimumStatus('Retain minimum', plan.sources.find(s => s.peer === peer)!.floor, current?.local);
      if (plan.mode === 'inbound') minimumStatus('Inbound target minimum', plan.sources.find(s => s.peer === peer)!.minimumInbound, current?.remote);
    } else if (plan.mode === 'outbound') {
      minimumStatus('Target minimum', plan.targets.find(t => t.peer === peer)!.minimum, current?.local);
    } else {
      const maximum = plan.targets.find(t => t.peer === peer)!.maximum;
      const status = !current ? 'unverified' : current.local <= maximum ? 'within limit' : `${fmt(current.local - maximum)} sats above limit`;
      lines.push(`    Maximum outbound: ${fmt(maximum)} sats · ${status}`);
    }
    if (current && (progress.find(g => g.peer === peer)?.remaining ?? 0) > 0) {
      const used = summary.results.filter(r => goalPeer(plan, r.attempt) === peer).length;
      if (used >= plan.maxAttemptsPerItem) lines.push(`    Attempt limit reached: ${used} / ${plan.maxAttemptsPerItem} for this ${role}.`);
    }
  }
  lines.push('  Balance changes include any forwarding or other activity during the session.');
  return lines.join('\n');
}
