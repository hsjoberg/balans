import { expect, test } from 'bun:test';
import { channelChoices } from '../src/channel-display.ts';
import { formatGoalGuidance, goalGuidance } from '../src/goal-guidance.ts';
import { peers, type Channel } from '../src/model.ts';

const channel = (peer: string, local: number, extra: Partial<Channel> = {}): Channel => ({
  id: peer, peer, alias: peer, local, remote: 1_000_000 - local, capacity: 1_000_000, reserve: 10_000, remoteReserve: 10_000, active: true, pending: 0, ...extra,
});

test('guidance suggests inbound when more eligible peers are full and names candidates', () => {
  const list = peers([channel('full-a', 990_000), channel('full-b', 980_000), channel('empty', 0)]);
  const before = structuredClone(list);
  expect(goalGuidance(list).recommended).toBe('inbound');
  const text = formatGoalGuidance(list);
  expect(text).toContain('full-a: 990,000 outbound / 10,000 inbound sats');
  expect(text).toContain('empty: 0 outbound / 1,000,000 inbound sats');
  expect(text).toContain('These are candidates, not selections.');
  expect(list).toEqual(before);
});

test('guidance suggests outbound for empty peers and excludes offline/pending liquidity', () => {
  const list = peers([channel('full', 990_000), channel('empty-a', 0), channel('empty-b', 0), channel('offline', 990_000, { active: false }), channel('pending', 990_000, { pending: 1 })]);
  const guidance = goalGuidance(list);
  expect(guidance.recommended).toBe('outbound');
  expect(guidance.sources.map(p => p.id)).toEqual(['full']);
});

test('guidance does not recommend a strategy when peers are balanced or no pair is available', () => {
  expect(goalGuidance(peers([channel('a', 500_000), channel('b', 500_000)])).recommended).toBeUndefined();
  expect(goalGuidance(peers([channel('a', 1_000_000), channel('b', 1_000_000)])).recommended).toBeUndefined();
  expect(goalGuidance(peers([channel('only', 500_000)])).recommended).toBeUndefined();
});

test('inbound mode preselects eligible full sources, outbound mode leaves sources unselected', () => {
  const list = peers([channel('full', 990_000), channel('offline', 990_000, { active: false }), channel('balanced', 500_000), channel('empty', 0)]);
  const inbound = channelChoices(list, 'out', { goal: 'inbound', color: false });
  expect(inbound.filter(c => c.checked).map(c => c.value)).toEqual(['full']);
  expect(channelChoices(list, 'out', { goal: 'outbound', color: false }).some(c => c.checked)).toBe(false);
  expect(channelChoices(list, 'in', { goal: 'inbound', color: false }).filter(c => c.checked).map(c => c.value)).toEqual(['empty']);
});
