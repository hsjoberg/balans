// Enforce payment limits independently of BOS's route discovery and amount
// calculations. Probes have no payable local invoice; real payments do.
function enforceRebalanceLimits(lnd, attempt) {
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (![attempt.amount, attempt.maxFee, attempt.maxFeeRate].every(positive)) throw new Error('InvalidRebalanceLimits');
  const maxAmount = BigInt(attempt.amount) * 1000n;
  const maxFee = BigInt(attempt.maxFee) * 1000n;
  const maxRate = BigInt(attempt.maxFeeRate);
  const parse = value => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error();
    if (!/^[0-9]+$/.test(String(value))) throw new Error();
    return BigInt(value);
  };
  const reject = (callback, message) => {
    const error = Object.assign(new Error(message), { code: 3, details: message });
    queueMicrotask(() => callback(error));
  };
  const invoiceHashes = new Set();
  const addInvoice = lnd.default.addInvoice.bind(lnd.default);
  lnd.default.addInvoice = (request, ...args) => {
    const callback = args.pop();
    try {
      const amount = request.value_msat !== undefined ? parse(request.value_msat) : parse(request.value) * 1000n;
      if (amount <= 0n || amount > maxAmount || invoiceHashes.size) return reject(callback, 'RebalanceInvoiceAmountOutsideLimit');
    } catch { return reject(callback, 'InvalidRebalanceInvoiceAmount'); }
    return addInvoice(request, ...args, (error, response) => {
      if (error) return callback(error);
      if (!Buffer.isBuffer(response?.r_hash) || response.r_hash.length !== 32) return reject(callback, 'InvalidRebalanceInvoiceHash');
      invoiceHashes.add(response.r_hash.toString('hex'));
      callback(null, response);
    });
  };
  const send = lnd.router.sendToRouteV2.bind(lnd.router);
  lnd.router.sendToRouteV2 = (request, ...args) => {
    const callback = args.pop();
    // Before invoice creation BOS is only probing with unpayable hashes.
    if (!invoiceHashes.size) return send(request, ...args, callback);
    const hash = Buffer.isBuffer(request.payment_hash) ? request.payment_hash.toString('hex') : '';
    if (!invoiceHashes.has(hash)) return reject(callback, 'UnexpectedRebalancePaymentHash');
    try {
      const total = parse(request.route.total_amt_msat);
      const fee = parse(request.route.total_fees_msat);
      const amount = total - fee;
      const last = request.route.hops.at(-1);
      if (amount <= 0n || amount > maxAmount || parse(last?.amt_to_forward_msat) !== amount) return reject(callback, 'RebalancePaymentAmountOutsideLimit');
      if (fee > maxFee || fee * 1_000_000n > total * maxRate) return reject(callback, 'RebalancePaymentFeeOutsideLimit');
    } catch { return reject(callback, 'InvalidRebalancePaymentRoute'); }
    return send(request, ...args, callback);
  };
}

module.exports = { enforceRebalanceLimits };
