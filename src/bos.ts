import { fileURLToPath } from 'node:url';
import type { Backend, Channel, Outcome } from './model.ts';

const worker = fileURLToPath(new URL('./bos-worker.cjs', import.meta.url));

// Only errors known to occur before BOS submits payment can release a reservation.
const prepaymentFailures = new Set([
  'RebalanceTotalFeeTooHigh', 'RebalanceFeeRateTooHigh',
  'NoOutboundChannelNeedsRebalance', 'NoHighInboundLowFeeChannelToReceiveRebalance',
  'FailedToFindPathBetweenPeers', 'ProbeTimeout',
  'NoActiveChannelWithOutgoingPeer', 'NoOutboundPeerWithSufficientBalance',
  'FailedToStartProbeForRoute', 'MaxFeeLimitTooLow',
  'LowRebalanceAmount', 'EncounteredUnexpectedRouteLiquidityFailure',
  // probing/find_max_payable rejects changed policies before BOS creates the
  // invoice. Errors from an actual payment are wrapped by BOS separately.
  'FeeIncreasedOnChannel',
  // Invoice creation must finish before BOS can construct or pay its route.
  // This may leave an unpaid invoice if the RPC response was lost, but no payment.
  'AddInvoiceError',
]);

function btcSats(value: unknown): number {
  if (value === undefined) return 0; // BOS omits zero amounts.
  if (typeof value !== 'string' || !/^\d+\.\d{8}$/.test(value)) throw new Error('Unexpected BOS amount.');
  const n = Number(BigInt(value.replace('.', '')));
  if (!Number.isSafeInteger(n)) throw new Error('BOS amount exceeds safe integer range.');
  return n;
}

export function decodeRebalance(response: any): Outcome {
  if (response?.ok === false) {
    const reason = typeof response.reason === 'string' ? response.reason : 'UnknownBosError';
    const details = [response.diagnostics?.guardReason, response.diagnostics?.rpcStatus]
      .filter((value): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value));
    const message = details.length ? `${reason} (${details.join('; ')})` : reason;
    // A node-local invoice failure is unpaid, but changing routes/peers won't
    // address it. Keep accounting certainty separate from whether to continue.
    if (reason === 'AddInvoiceError') return { status: 'failed', reason: message, stop: true };
    return { status: prepaymentFailures.has(reason) ? 'failed' : 'unknown', reason: message };
  }
  if (response?.ok !== true || !Array.isArray(response.result?.rebalance)) throw new Error('Missing BOS rebalance result.');
  const payment = response.result.rebalance.find((row: any) => row.rebalanced !== undefined);
  if (!payment) throw new Error('Missing BOS payment result.');
  const fee = btcSats(payment.rebalance_fees_spent);
  const paymentId = response.result.payment_id;
  if (paymentId !== undefined && (typeof paymentId !== 'string' || !/^[0-9a-f]{64}$/i.test(paymentId))) throw new Error('Invalid BOS payment ID.');
  // BOS reports total sent including fee, and rounds fees down to whole sats.
  // Account for an extra sat; this is a conservative fee ceiling, not an exact receipt.
  return { status: 'success', moved: btcSats(payment.rebalanced) - fee, fee: fee + 1, ...(paymentId ? { paymentId } : {}) };
}

export function decodeChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) throw new Error('Invalid channel snapshot from BOS.');
  return value.map(c => {
    if (!c || typeof c.id !== 'string' || typeof c.peer !== 'string' || typeof c.alias !== 'string' || typeof c.active !== 'boolean') throw new Error('Invalid channel identity from BOS.');
    for (const key of ['capacity', 'local', 'remote', 'reserve', 'remoteReserve', 'pending']) {
      if (!Number.isSafeInteger(c[key]) || c[key] < 0) throw new Error(`Invalid channel ${key} from BOS.`);
    }
    if (c.local > c.capacity || c.remote > c.capacity) throw new Error('Invalid channel balance from BOS.');
    return c as Channel;
  });
}

export function bosBackend(node: string): Backend {
  async function call(action: string, attempt?: unknown) {
    // Use this exact Bun executable, regardless of the system's Node or PATH.
    const child = Bun.spawn([process.execPath, worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ action, node, attempt }));
    child.stdin.end();
    // Do not impose a kill timeout: LND may still settle an in-flight payment.
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    try { return JSON.parse(stdout); }
    catch { throw new Error('BOS worker did not return a JSON response. Check bun --version and run bun install --frozen-lockfile.'); }
  }
  return {
    async snapshot() {
      const response = await call('snapshot');
      if (!response.ok) {
        const d = response.diagnostics;
        const context = d ? `\nStage: ${d.stage} · Bun: ${d.bunVersion}${d.errorType ? ` · ${d.errorType}` : ''}${d.code ? ` · ${d.code}` : ''}${d.location ? ` · ${d.location}` : ''}` : '';
        const hint = '\nCheck that the BOS saved-node credentials and LND endpoint are accessible to this user.';
        throw new Error(`Could not read channels: ${response.reason}.${context}${hint}`);
      }
      return decodeChannels(response.result);
    },
    async rebalance(attempt) { return decodeRebalance(await call('rebalance', attempt)); },
  };
}
