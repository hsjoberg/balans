import { cleanAlias, cleanText, fmt, goalPeer, goalProgress, peers, type Plan } from './model.ts';
import type { SessionSummary } from './runner.ts';
import { terminalStyle } from './terminal-style.ts';

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

export function formatSessionReport(plan: Plan, summary: SessionSummary, fallbackName: (peer: string) => string = peer => peer, color = false): string {
  const style = terminalStyle(color);
  const observed = [...(summary.after ?? []), ...(summary.before ?? [])];
  const name = (peer: string) => cleanAlias(observed.find(c => c.peer === peer)?.alias ?? fallbackName(peer));
  const succeeded = summary.results.filter(r => r.outcome.status === 'success');
  const failed = summary.results.filter(r => r.outcome.status === 'failed');
  const unresolved = summary.results.filter(r => r.outcome.status === 'unknown');
  const fees = succeeded.reduce((sum, r) => sum + (r.outcome.status === 'success' ? r.outcome.fee : 0), 0);
  const stoppedOnError = unresolved.length > 0 || summary.balanceReadFailed || failed.some(r => r.outcome.status === 'failed' && r.outcome.stop);
  const endStyle = stoppedOnError ? style.error : summary.reason === 'targets reached' ? style.success : style.warning;
  const remainingBudget = Math.max(0, plan.budget - summary.spent);
  const lines = [
    `\n${style.strong('Session ended:')} ${endStyle(cleanText(summary.reason).replace(/[.!]+$/, '') + '.')}`,
    `${(succeeded.length ? style.success : style.muted)(`${succeeded.length} succeeded`)} · ${(failed.length ? style.warning : style.muted)(`${failed.length} failed`)}${unresolved.length ? ` · ${style.error(`${unresolved.length} unresolved`)}` : ''} · ${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'}`,
    `${unresolved.length ? 'Confirmed moved' : 'Moved'}: ${style.info(`${fmt(summary.moved)} sats`)} · ${unresolved.length ? 'Confirmed fees' : 'Fees'}: ${style.warning(`≈${fmt(fees)} sats`)}`,
    `Budget remaining: ${(remainingBudget < 2 ? style.warning : style.info)(fmt(remainingBudget))} / ${fmt(plan.budget)} sats`,
  ];
  if (unresolved.length) lines.push(style.error(`Reserved for unresolved payments: ${fmt(summary.spent - fees)} sats`));
  lines.push('\n' + style.strong('Rebalance attempts'));
  if (!summary.results.length) lines.push(style.muted('  No rebalances submitted.'));
  summary.results.forEach(({ attempt, outcome }, index) => {
    lines.push(`  ${index + 1}. ${style.strong(name(attempt.source))} → ${style.strong(name(attempt.target))}`);
    if (outcome.status === 'success') lines.push(`     ${style.success(`Moved ${fmt(outcome.moved)} sats`)} · Fees ${style.warning(`≈${fmt(outcome.fee)} sats`)}`);
    else if (outcome.status === 'failed') lines.push(`     ${(outcome.stop ? style.error : style.warning)(`Failed before payment${outcome.stop ? ' · session stopped' : ''}: ${cleanText(outcome.reason)}`)}`);
    else {
      lines.push(`     ${style.error(`Unresolved payment: ${cleanText(outcome.reason)}`)}`);
      if (outcome.reported) lines.push(`     BOS reported ${fmt(outcome.reported.moved)} sats moved; fees ≈${fmt(outcome.reported.fee)} sats. Requested maximum: ${fmt(attempt.amount)} sats.`);
      if (outcome.reported?.paymentId) lines.push(`     Payment ID: ${cleanText(outcome.reported.paymentId)}`);
    }
  });

  lines.push('\n' + style.strong(`Observed channel balances · ${plan.mode === 'inbound' ? 'outbound and inbound' : 'outbound'} sats`));
  if (summary.balanceReadFailed) lines.push(style.error('  Final balances unavailable: the channel read failed.'));
  if (!summary.before) lines.push(style.warning('  No starting balance snapshot is available.'));
  const finalPeers = summary.after ? peers(summary.after) : undefined;
  const progress = finalPeers ? goalProgress(plan, finalPeers) : [];
  const minimumStatus = (label: string, minimum: number, balance: number | undefined, isFloor = false) => {
    const status = balance === undefined ? 'unverified' : balance >= minimum ? 'met' : `${fmt(minimum - balance)} sats short`;
    const tone = balance === undefined ? style.warning : balance >= minimum ? style.success : isFloor ? style.error : style.warning;
    lines.push(`    ${label}: ${fmt(minimum)} sats · ${tone(status)}`);
  };
  const roles = [
    ...plan.sources.map(s => ({ peer: s.peer, role: 'source' })),
    ...plan.targets.map(t => ({ peer: t.peer, role: 'destination' })),
  ];
  for (const { peer, role } of roles) {
    const before = (summary.before ?? []).filter(c => c.peer === peer);
    const after = (summary.after ?? []).filter(c => c.peer === peer);
    const ids = [...new Set([...before, ...after].map(c => c.id))];
    lines.push(`  ${style.strong(name(peer))} · ${style.muted(role + (ids.length > 1 ? ` · ${ids.length} channels` : ''))}`);
    if (!ids.length) lines.push(style.warning('    Channel balances unavailable.'));
    for (const id of ids) {
      const start = before.find(c => c.id === id);
      const end = after.find(c => c.id === id);
      const delta = start && end ? ` ${(end.local === start.local ? style.muted : style.info)(`(${signed(end.local - start.local)})`)}` : '';
      lines.push(`    ${style.muted(cleanAlias(id))}: ${start ? fmt(start.local) : style.warning('unavailable')} → ${end ? style.strong(fmt(end.local)) : style.warning('unavailable')}${delta}`);
      if (plan.mode === 'inbound') {
        const inboundDelta = start && end ? ` ${(end.remote === start.remote ? style.muted : style.info)(`(${signed(end.remote - start.remote)})`)}` : '';
        lines.push(`      Inbound: ${start ? fmt(start.remote) : style.warning('unavailable')} → ${end ? style.strong(fmt(end.remote)) : style.warning('unavailable')}${inboundDelta}`);
      }
    }
    const current = finalPeers?.find(p => p.id === peer);
    if (role === 'source') {
      minimumStatus('Retain minimum', plan.sources.find(s => s.peer === peer)!.floor, current?.local, true);
      if (plan.mode === 'inbound') minimumStatus('Inbound target minimum', plan.sources.find(s => s.peer === peer)!.minimumInbound, current?.remote);
    } else if (plan.mode === 'outbound') {
      minimumStatus('Target minimum', plan.targets.find(t => t.peer === peer)!.minimum, current?.local);
    } else {
      const maximum = plan.targets.find(t => t.peer === peer)!.maximum;
      const status = !current ? 'unverified' : current.local <= maximum ? 'within limit' : `${fmt(current.local - maximum)} sats above limit`;
      lines.push(`    Maximum outbound: ${fmt(maximum)} sats · ${(!current ? style.warning : current.local <= maximum ? style.success : style.error)(status)}`);
    }
    if (current && (progress.find(g => g.peer === peer)?.remaining ?? 0) > 0) {
      const used = summary.results.filter(r => goalPeer(plan, r.attempt) === peer).length;
      if (used >= plan.maxAttemptsPerItem) lines.push(style.warning(`    Attempt limit reached: ${used} / ${plan.maxAttemptsPerItem} for this ${role}.`));
    }
  }
  lines.push(style.muted('  Balance changes include any forwarding or other activity during the session.'));
  return lines.join('\n');
}
