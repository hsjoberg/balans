// Run BOS inside an isolated Bun worker; no Node executable is needed.
const { createRequire } = require('node:module');
const { readFile } = require('node:fs');
const { workerFailure } = require('./bos-worker-errors.cjs');
const { publicChannelsOnly } = require('./public-channels.cjs');
const { enforceRebalanceLimits } = require('./rebalance-limits.cjs');
require('./bun-grpc-tls.cjs');
const logger = { info() {}, warn() {}, error() {}, debug() {} };

// Do not kill a potentially settling payment when the wizard requests a stop.
process.on('SIGINT', () => {});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  let stage = 'request parsing';
  try {
    const request = JSON.parse(input);
    if (!['snapshot', 'rebalance'].includes(request.action)) throw new Error('UnknownWorkerAction');
    stage = 'loading BOS dependencies';
    const bosRequire = createRequire(require.resolve('balanceofsatoshis/package.json'));
    const { getChannels, getNode } = bosRequire('ln-service');
    const authenticatedLnd = require('balanceofsatoshis/lnd/authenticated_lnd');
    const rebalance = require('balanceofsatoshis/swaps/rebalance');
    stage = 'loading credentials and connecting to LND';
    const { lnd } = await authenticatedLnd({ node: request.node, logger });
    publicChannelsOnly(lnd);
    let result;
    if (request.action === 'snapshot') {
      stage = 'reading channels from LND';
      const { channels } = await getChannels({ lnd, is_public: true });
      stage = 'reading peer aliases';
      const aliases = new Map();
      // Limit concurrent alias lookups so channel listing is gentle on LND.
      const ids = [...new Set(channels.map(c => c.partner_public_key))];
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(async public_key => {
          try {
            const node = await getNode({ lnd, public_key, is_omitting_channels: true });
            aliases.set(public_key, node.alias || public_key.slice(0, 16));
          } catch { aliases.set(public_key, public_key.slice(0, 16)); }
        }));
      }
      stage = 'formatting channel snapshot';
      result = channels.map(c => ({
        id: c.id, peer: c.partner_public_key, alias: aliases.get(c.partner_public_key),
        capacity: c.capacity, local: c.local_balance, remote: c.remote_balance,
        reserve: c.local_reserve, remoteReserve: c.remote_reserve,
        active: c.is_active, pending: c.pending_payments.length,
      }));
    } else {
      stage = 'executing BOS rebalance';
      const a = request.attempt;
      enforceRebalanceLimits(lnd, a);
      result = await rebalance({
        lnd, logger, fs: { getFile: readFile },
        avoid: [], in_filters: [], out_filters: [],
        in_through: a.target, out_through: a.source,
        max_rebalance: String(a.amount), max_fee: a.maxFee,
        max_fee_rate: a.maxFeeRate, timeout_minutes: a.minutes,
      });
    }
    process.stdout.write(JSON.stringify({ ok: true, result }), () => process.exit(0));
  } catch (err) {
    process.stdout.write(JSON.stringify(workerFailure(err, stage)), () => process.exit(1));
  }
});
