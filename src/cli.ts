#!/usr/bin/env bun
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { parseArgs } from 'node:util';
import { bosBackend } from './bos.ts';
import { demoBackend } from './demo.ts';
import { checkSessionLock, openJournal } from './journal.ts';
import { cleanAlias, fmt, MIN_AMOUNT, peers, sats, validatePlan, type Goal, type Plan } from './model.ts';
import { runSession } from './runner.ts';
import { balanceLegend, channelChoices, channelTheme } from './channel-display.ts';
import { formatSessionReport } from './session-report.ts';
import { formatGoalGuidance, goalGuidance } from './goal-guidance.ts';

const help = `balans — manual Lightning rebalancing, powered by BOS

Usage: bun run start --node <name> [--target-outbound <sats>] [--target-inbound <sats>] [--dry-run]
       bun run demo [--target-outbound <sats>] [--target-inbound <sats>]

  --node <name>             Existing BOS saved node (prompted if omitted)
  --target-outbound <sats>  Default destination outbound minimum (default: 1m; accepts k/m)
  --target-inbound <sats>   Default source inbound minimum (default: 1m; accepts k/m)
  --demo                   Use simulated channels; no node connection or payments
  --dry-run                Read balances and build a plan; do not rebalance
  --help                   Show this help

Choose whether to increase outbound or inbound liquidity, or get help choosing.
Budget means total routing fees for this session, not sats moved.
Multiple channels with the same peer share combined goals and limits.
Live mode uses Bun and your existing BOS credentials. Node.js is not required.
`;

async function number(message: string, initial: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return sats(await input({
    message, default: String(initial),
    validate(value) {
      try {
        const n = sats(value);
        return n >= min && n <= max ? true : `Enter a value between ${fmt(min)} and ${fmt(max)}.`;
      } catch (err) { return (err as Error).message; }
    },
  }));
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { node: { type: 'string' }, 'target-outbound': { type: 'string' }, 'target-inbound': { type: 'string' }, demo: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  if (values.help) { console.log(help); return; }
  const targetDefault = (flag: 'target-outbound' | 'target-inbound') => {
    try { return sats(values[flag] ?? '1m'); }
    catch (error) { throw new Error(`Invalid --${flag}: ${(error as Error).message}`); }
  };
  const defaultOutbound = targetDefault('target-outbound');
  const defaultInbound = targetDefault('target-inbound');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The wizard needs an interactive terminal. Headless execution is not available yet. Use --help for usage.');
  const demo = !!values.demo;
  console.log(`\nBALANS  /  ${demo ? 'DEMO — simulated payments only' : 'manual rebalance session'}\n`);
  const node = demo ? 'demo' : (values.node ?? await input({ message: 'BOS saved node', validate: v => v.trim().length > 0 || 'Enter a saved node name.' })).trim();
  if (!node) throw new Error('Enter a saved node name.');
  checkSessionLock(node);
  const backend = demo ? demoBackend() : bosBackend(node);
  console.log('Reading public channels…');
  const initial = peers(await backend.snapshot());
  if (!initial.length) throw new Error('No open public channels were found.');
  if (initial.some(p => p.channels.length > 1)) console.log('Peers with multiple channels are grouped. Goals and limits apply to their combined balances.');
  console.log('Inactive channels and channels with pending HTLCs contribute no available liquidity in the planner.\n');

  const goalChoices = [
    { name: 'Increase outbound liquidity — refill channels so they can send more', value: 'outbound' as const },
    { name: 'Increase inbound liquidity — drain channels so they can receive more', value: 'inbound' as const },
  ];
  const choice = await select({ message: '1/7 · What do you want to achieve?', choices: [...goalChoices, { name: "I don't know — help me choose", value: 'help' as const }] });
  let mode: Goal;
  if (choice === 'help') {
    console.log(formatGoalGuidance(initial));
    const { recommended } = goalGuidance(initial);
    mode = await select({ message: 'Choose the goal you want to work on', default: recommended, choices: goalChoices.map(c => ({ ...c, name: c.name + (c.value === recommended ? ' (suggested from balances)' : '') })) });
  } else mode = choice;
  if (!initial.some(p => p.spendable >= MIN_AMOUNT + 2)) throw new Error('No source has enough available outbound liquidity.');
  if (mode === 'inbound' && values['target-outbound'] !== undefined) console.log('--target-outbound applies to outbound goals. This goal uses --target-inbound for source targets.');
  if (mode === 'outbound' && values['target-inbound'] !== undefined) console.log('--target-inbound applies to inbound goals. This goal uses --target-outbound for destination targets.');

  console.log(balanceLegend);
  if (!initial.some(p => p.receivable >= MIN_AMOUNT)) throw new Error('No peer has enough available inbound liquidity to receive a rebalance.');
  let sourceIds: string[];
  let targetIds: string[];
  if (mode === 'outbound') {
    console.log('\nChoose the channels you want to refill. Sats will arrive through them, increasing their outbound balance.');
    targetIds = await checkbox({
      message: '2/7 · Which peers need more outbound liquidity? (≤5% outbound preselected)', pageSize: 15, theme: channelTheme,
      choices: channelChoices(initial, 'in'),
      validate: choices => !choices.length ? 'Choose at least one peer to refill.'
        : initial.some(p => !choices.some(c => c.value === p.id) && p.spendable >= MIN_AMOUNT + 2) || 'Leave at least one eligible peer to supply the sats.',
    });
    sourceIds = await checkbox({
      message: '3/7 · Supply the sats from which other peers?', pageSize: 15, theme: channelTheme,
      choices: channelChoices(initial.filter(p => !targetIds.includes(p.id)), 'out'),
      validate: choices => choices.length > 0 || 'Choose at least one funding peer.',
    });
  } else {
    console.log('\nChoose the channels you want to drain. Sats will leave through them, creating inbound room to receive.');
    sourceIds = await checkbox({
      message: '2/7 · Which peers need more inbound liquidity? (≥95% outbound preselected)', pageSize: 15, theme: channelTheme,
      choices: channelChoices(initial, 'out', { goal: mode }),
      validate: choices => !choices.length ? 'Choose at least one peer to create inbound room on.'
        : initial.some(p => !choices.some(c => c.value === p.id) && p.receivable >= MIN_AMOUNT) || 'Leave at least one eligible peer to receive the sats.',
    });
    targetIds = await checkbox({
      message: '3/7 · Move their sats into which other peers? (≤5% outbound preselected)', pageSize: 15, theme: channelTheme,
      choices: channelChoices(initial.filter(p => !sourceIds.includes(p.id)), 'in'),
      validate: choices => choices.length > 0 || 'Choose at least one receiving peer.',
    });
  }
  const limits = { node, budget: 0, maxFee: 0, maxFeeRate: 0, chunk: 500_000, minutes: 5, maxAttemptsPerItem: 20 };
  const plan: Plan = mode === 'outbound' ? { ...limits, mode, sources: [], targets: [] } : { ...limits, mode, sources: [], targets: [] };
  console.log('\n4/7 · Set liquidity goals and limits. Amounts accept k/m suffixes.');
  if (plan.mode === 'outbound') {
    for (const peer of targetIds) {
      const p = initial.find(p => p.id === peer)!;
      const ceiling = p.local + p.receivable;
      const minimum = await number(`${p.alias}: target minimum outbound sats${p.channels.length > 1 ? ' (combined)' : ''}`, Math.min(defaultOutbound, ceiling), 0, ceiling);
      plan.targets.push({ peer, minimum });
    }
    for (const peer of sourceIds) {
      const p = initial.find(p => p.id === peer)!;
      const floor = await number(`${p.alias}: keep at least this many outbound sats`, Math.min(1_000_000, p.local), 0, p.local);
      plan.sources.push({ peer, floor });
    }
  } else {
    for (const peer of sourceIds) {
      const p = initial.find(p => p.id === peer)!;
      const floor = await number(`${p.alias}: keep at least this many outbound sats`, Math.min(1_000_000, p.local), 0, p.local);
      const ceiling = p.remote + Math.min(p.spendable, p.local - floor);
      const minimumInbound = await number(`${p.alias}: target minimum inbound sats${p.channels.length > 1 ? ' (combined)' : ''}`, Math.min(defaultInbound, ceiling), 0, ceiling);
      plan.sources.push({ peer, floor, minimumInbound });
    }
    for (const peer of targetIds) {
      const p = initial.find(p => p.id === peer)!;
      const ceiling = p.local + p.receivable;
      const maximum = await number(`${p.alias}: maximum outbound sats after receiving`, Math.max(p.local, Math.min(Math.floor(p.capacity / 2), ceiling)), p.local, ceiling);
      plan.targets.push({ peer, maximum });
    }
  }
  plan.budget = await number('5/7 · Total routing-fee budget for this session (sats)', 15_000, 2);
  plan.maxFee = await number('6/7 · Maximum fee per rebalance (sats)', Math.min(5_000, plan.budget), 2);
  plan.maxFeeRate = await number('Maximum fee rate (ppm, BOS semantics)', 5_000, 1);
  const itemLabel = mode === 'outbound' ? 'destination' : 'source';
  console.log(`\nAttempts use up to 500,000 sats, a 5-minute route-search timeout, and at most 20 attempts per ${itemLabel}.`);
  if (await confirm({ message: 'Customize these execution limits?', default: false })) {
    plan.chunk = await number('Maximum sats per attempt', plan.chunk, MIN_AMOUNT, 4_294_967);
    plan.minutes = await number('Route-search timeout per attempt (minutes)', plan.minutes, 1, 60);
    plan.maxAttemptsPerItem = await number(`Maximum attempts per ${itemLabel}`, plan.maxAttemptsPerItem, 1, 1_000);
  }
  validatePlan(plan);
  const name = (id: string) => initial.find(p => p.id === id)?.alias ?? id;
  console.log(`\n7/7 · Review ${demo ? 'SIMULATED' : 'LIVE'} session — node ${cleanAlias(node)} · increase ${mode}`);
  if (plan.mode === 'outbound') {
    console.log('Refill these channels to their outbound targets:');
    console.table(plan.targets.map(t => {
      const p = initial.find(p => p.id === t.peer)!;
      return { Destination: name(t.peer), Outbound: fmt(p.local), Target: fmt(t.minimum), Need: fmt(Math.max(0, t.minimum - p.local)) };
    }));
    console.log('Supply the sats from these channels:');
    console.table(plan.sources.map(s => ({ Source: name(s.peer), 'Keep outbound': fmt(s.floor) })));
  } else {
    console.log('Drain these channels until their inbound targets are met:');
    console.table(plan.sources.map(s => {
      const p = initial.find(p => p.id === s.peer)!;
      return { Source: name(s.peer), Inbound: fmt(p.remote), 'Inbound target': fmt(s.minimumInbound), Need: fmt(Math.max(0, s.minimumInbound - p.remote)), 'Keep outbound': fmt(s.floor) };
    }));
    console.log('Receive the sats in these channels, within their outbound caps:');
    console.table(plan.targets.map(t => {
      const p = initial.find(p => p.id === t.peer)!;
      return { Destination: name(t.peer), Outbound: fmt(p.local), 'Max outbound': fmt(t.maximum), 'May receive': fmt(Math.max(0, t.maximum - p.local)) };
    }));
  }
  console.log(`Fee budget: ${fmt(plan.budget)} sats · Max fee: ${fmt(plan.maxFee)} sats/attempt · Max rate: ${fmt(plan.maxFeeRate)} ppm`);
  console.log(`Chunk: up to ${fmt(plan.chunk)} sats · Route search: ${plan.minutes} min · Attempts: at most ${plan.maxAttemptsPerItem} per ${itemLabel}`);
  console.log('A final 50,000-sat attempt may slightly exceed a target to reach its minimum. All fee and liquidity limits still apply.');
  if (values['dry-run']) { console.log('\nDry run complete. No rebalances submitted.'); return; }
  if (!await confirm({ message: demo ? 'Run this simulation?' : 'Start rebalancing with these limits?', default: false })) { console.log('Cancelled. No rebalances submitted.'); return; }

  const journal = openJournal(node);
  let uncertain = false;
  let stopping = false;
  const stop = () => { stopping = true; console.log('\nStopping after the current BOS call settles. Keep this terminal open.'); };
  process.on('SIGINT', stop);
  try {
    journal.write({ type: 'plan', demo, plan });
    console.log(`Session journal: ${journal.path}\nCtrl+C requests a stop after the current attempt.\n`);
    const summary = await runSession(plan, backend, event => {
      journal.write(event);
      if (event.type === 'reserved') {
        uncertain = true;
        console.log(`${name(event.attempt.source)} → ${name(event.attempt.target)}: up to ${fmt(event.attempt.amount)} sats; fee cap ${fmt(event.attempt.reserved)} sats. BOS is searching…`);
      } else {
        uncertain = event.outcome.status === 'unknown';
        if (event.outcome.status === 'success') console.log(`  Moved ${fmt(event.outcome.moved)} sats; fees ≈${fmt(event.outcome.fee)} sats; budget remaining ${fmt(plan.budget - event.spent)} sats.`);
        else console.log(`  ${event.outcome.status}: ${event.outcome.reason}`);
      }
    }, () => stopping);
    journal.write({ type: 'summary', ...summary });
    console.log(formatSessionReport(plan, summary, name));
    if (uncertain) console.log('Session lock retained. Reconcile the unresolved payment in LND and inspect the journal before removing the lock and starting again.');
    if (uncertain || summary.balanceReadFailed || summary.results.some(r => r.outcome.status === 'failed' && r.outcome.stop)) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    journal.close(uncertain);
  }
}

main().catch(error => {
  if (error?.name === 'ExitPromptError') { console.log('\nCancelled.'); process.exitCode = 130; return; }
  console.error(`\n${error instanceof Error ? error.message : 'Unexpected failure. Inspect the session journal before retrying.'}`);
  process.exitCode = 1;
});
