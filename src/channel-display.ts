import { cleanAlias, fmt, MIN_AMOUNT, type Goal, type Peer } from './model.ts';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function column(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text + ' '.repeat(width - Bun.stringWidth(text));
  let clipped = '';
  for (const { segment } of segments.segment(text)) {
    if (Bun.stringWidth(clipped + segment) > width - 1) break;
    clipped += segment;
  }
  return clipped + '…' + ' '.repeat(width - Bun.stringWidth(clipped) - 1);
}

function compact(n: number): string {
  for (const [scale, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (n >= scale) return `${(n / scale).toFixed(2)}${suffix}`;
  }
  return String(n);
}

export function balanceBar(ratio: number, width: number, color = false): string {
  const units = Math.round(Math.max(0, Math.min(1, ratio)) * width * 8);
  const full = Math.floor(units / 8);
  const fraction = units % 8;
  const filled = '█'.repeat(full) + (fraction ? '▏▎▍▌▋▊▉'[fraction - 1] : '');
  const empty = '░'.repeat(width - full - (fraction ? 1 : 0));
  return color ? `\x1b[36m${filled}\x1b[39m\x1b[90m${empty}\x1b[39m` : filled + empty;
}

export function channelChoices(list: Peer[], side: 'out' | 'in', options: { columns?: number; color?: boolean; goal?: Goal } = {}) {
  const columns = options.columns ?? (process.stdout.columns || 80);
  const color = options.color ?? (!!process.stdout.isTTY && process.env.NO_COLOR === undefined);
  const barWidth = columns >= 78 ? 16 : 10;
  const aliasWidth = Math.max(10, Math.min(28, columns - barWidth - 45));
  const narrow = columns < 65;
  const outboundRatio = (p: Peer) => p.capacity ? p.local / p.capacity : 0;
  const sorted = [...list].sort((a, b) => {
    const difference = outboundRatio(a) - outboundRatio(b);
    return (side === 'out' ? -difference : difference) || a.alias.localeCompare(b.alias);
  });
  return sorted.map(p => {
    const ratio = p.capacity ? p.local / p.capacity : 0;
    const group = p.channels.length > 1 ? ` [${p.channels.length}]` : '';
    const alias = column(column(cleanAlias(p.alias), aliasWidth - group.length).trimEnd() + group, aliasWidth);
    const bar = balanceBar(ratio, barWidth, color);
    const percentage = `${(ratio * 100).toFixed(1)}%`.padStart(6);
    const amounts = `${compact(p.local).padStart(7)} / ${compact(p.capacity).padStart(7)}`;
    const name = narrow ? `${alias}  ${bar} ${percentage}\n    ${amounts} sats out / capacity` : `${alias}  ${bar} ${percentage}  ${amounts}`;
    const available = side === 'out' ? p.spendable : p.receivable;
    const minimum = side === 'out' ? MIN_AMOUNT + 2 : MIN_AMOUNT;
    return {
      name, value: p.id, short: `${cleanAlias(p.alias)}${group}`,
      description: `${cleanAlias(p.alias)}${group ? ` · ${p.channels.length} channels, combined` : ''}\nOutbound ${fmt(p.local)} / ${fmt(p.capacity)} sats capacity · Inbound ${fmt(p.remote)} sats · Available ${side}: ${fmt(available)} sats\n${p.channels.length === 1 ? `Channel ${p.channels[0]!.id}` : `Channels ${p.channels.map(c => c.id).join(', ')}`}\nPeer ${p.id}`,
      disabled: available < minimum ? `(low ${side})` : false,
      checked: available >= minimum && (side === 'in' ? ratio <= 0.05 : options.goal === 'inbound' && ratio >= 0.95),
    };
  });
}

export const balanceLegend = 'Bar = outbound / capacity · Amounts in sats · [n] = combined channels';

// Fixed-width markers keep disabled rows aligned on Windows and Unix alike.
export const channelTheme = {
  icon: { checked: '[x]', unchecked: '[ ]', cursor: '›' },
  style: { disabledChoice: (text: string) => `  -  ${text}` },
};
