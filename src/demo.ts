import type { Backend, Channel } from './model.ts';

export function demoBackend(): Backend {
  const channel = (id: string, alias: string, local: number, capacity: number, peer: string, state: Partial<Pick<Channel, 'active' | 'pending'>> = {}): Channel => ({ id, alias, local, capacity, peer, remote: capacity - local, reserve: 10_000, remoteReserve: 10_000, active: true, pending: 0, ...state });
  const channels = [
    channel('100001x1x0', 'Cedar Relay', 14_283_760, 18_000_000, 'demo-cedar-relay'),
    channel('100002x2x0', 'Paper Lantern', 0, 6_500_000, 'demo-paper-lantern'),
    channel('100004x4x0', 'Copper Finch', 43_680, 750_000, 'demo-copper-finch'),
    channel('100007x7x0', 'Quartz Express', 30_000_000, 30_000_000, 'demo-quartz-express'),
    channel('100011x11x0', 'Pine Pocket', 0, 250_000, 'demo-pine-pocket'),
    channel('100018x18x0', 'Amber Bridge', 8_000_000, 8_000_000, 'demo-amber-bridge'),
    channel('100021x21x0', 'Sleeping Fox', 9_734_560, 10_000_000, 'demo-sleeping-fox', { active: false }),
    channel('100023x23x0', 'Cloud Orchard', 0, 1_500_000, 'demo-cloud-orchard'),
    channel('100024x24x0', 'Dune Sparrow', 0, 3_000_000, 'demo-dune-sparrow'),
  ];
  return {
    async snapshot() { return structuredClone(channels); },
    async rebalance(attempt) {
      const sources = channels.filter(c => c.peer === attempt.source && c.active && !c.pending);
      const destinations = channels.filter(c => c.peer === attempt.target && c.active && !c.pending);
      const fee = Math.min(attempt.maxFee, Math.max(1, Math.ceil(attempt.amount * 800 / 1_000_000)));
      const spendable = sources.reduce((sum, c) => sum + Math.max(0, c.local - c.reserve), 0);
      const receivable = destinations.reduce((sum, c) => sum + Math.max(0, c.remote - c.remoteReserve), 0);
      if (attempt.source === attempt.target || spendable < attempt.amount + fee || receivable < attempt.amount) {
        return { status: 'failed', reason: 'Insufficient simulated liquidity for this pair.' };
      }
      // Spread simulated transfers across a group's eligible channels, keeping
      // every channel balance valid even when a large chunk spans siblings.
      let outgoing = attempt.amount + fee;
      for (const c of sources) {
        const amount = Math.min(outgoing, Math.max(0, c.local - c.reserve));
        c.local -= amount;
        c.remote += amount;
        outgoing -= amount;
      }
      let incoming = attempt.amount;
      for (const c of destinations) {
        const amount = Math.min(incoming, Math.max(0, c.remote - c.remoteReserve));
        c.local += amount;
        c.remote -= amount;
        incoming -= amount;
      }
      return { status: 'success', moved: attempt.amount, fee };
    },
  };
}
