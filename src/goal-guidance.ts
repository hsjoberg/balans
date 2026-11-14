import { fmt, MIN_AMOUNT, type Goal, type Peer } from './model.ts';

// Guidance is a balance-based suggestion, not an automatic execution strategy.
export function goalGuidance(list: Peer[]): { recommended?: Goal; explanation: string; sources: Peer[]; destinations: Peer[] } {
  const ratio = (p: Peer) => p.capacity ? p.local / p.capacity : 0;
  const sources = list.filter(p => p.spendable >= MIN_AMOUNT + 2).sort((a, b) => ratio(b) - ratio(a));
  const destinations = list.filter(p => p.receivable >= MIN_AMOUNT).sort((a, b) => ratio(a) - ratio(b));
  const empty = destinations.filter(p => ratio(p) <= 0.05).length;
  const full = sources.filter(p => ratio(p) >= 0.95).length;
  const canMove = sources.some(s => destinations.some(d => s.id !== d.id));
  const recommended = canMove && (empty || full) ? (full > empty ? 'inbound' : 'outbound') : undefined;
  const explanation = !canMove
    ? 'No distinct sending and receiving peers currently have enough available liquidity for a rebalance.'
    : !recommended
      ? 'No eligible peers are near either extreme. Choose based on which channels you want to send or receive more through.'
      : `Eligible peers: ${empty} at ≤5% outbound, ${full} at ≥95% outbound. ${recommended === 'outbound' ? 'Refilling low-outbound peers' : 'Creating inbound room on high-outbound peers'} is a starting point based on those counts; your routing needs may differ.`;
  return { recommended, explanation, sources: sources.slice(0, 3), destinations: destinations.slice(0, 3) };
}

export function formatGoalGuidance(list: Peer[]): string {
  const guidance = goalGuidance(list);
  const describe = (p: Peer) => `${p.alias}: ${fmt(p.local)} outbound / ${fmt(p.remote)} inbound sats (${(p.capacity ? p.local / p.capacity * 100 : 0).toFixed(1)}% outbound)`;
  return [
    '\nOutbound liquidity lets a channel send. Inbound liquidity gives it room to receive.',
    'A rebalance sends out through one peer and returns through another: the source gains inbound, the destination gains outbound.',
    'It redistributes existing liquidity between your channels; it does not create more inbound liquidity overall.',
    '\n' + guidance.explanation,
    '\nPossible sources (send out to create inbound):',
    ...(guidance.sources.length ? guidance.sources.map(p => `  ${describe(p)}`) : ['  None currently eligible.']),
    '\nPossible destinations (receive to increase outbound):',
    ...(guidance.destinations.length ? guidance.destinations.map(p => `  ${describe(p)}`) : ['  None currently eligible.']),
    '\nThese are candidates, not selections. Choose a goal, then review the peers and amounts before starting.',
  ].join('\n');
}
