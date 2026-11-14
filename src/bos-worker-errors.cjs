// Report useful context without dumping credentials, RPC objects, or arbitrary
// exception messages (JSON parse errors can include credential file contents).
function workerFailure(error, stage, bunVersion = process.versions.bun) {
  const grpcStatuses = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
  const guardReasons = new Set([
    'RebalanceInvoiceAmountOutsideLimit', 'InvalidRebalanceInvoiceAmount',
    'InvalidRebalanceInvoiceHash', 'UnexpectedRebalancePaymentHash',
    'RebalancePaymentAmountOutsideLimit', 'RebalancePaymentFeeOutsideLimit',
    'InvalidRebalancePaymentRoute',
  ]);
  // BOS/ln-service wrap RPC errors in [status, reason, {err}]. Preserve only
  // fixed status names and our own guard codes, never arbitrary RPC messages.
  let rpcStatus;
  let guardReason;
  let nested = error;
  for (let depth = 0; nested && depth < 6; depth++) {
    if (Number.isInteger(nested.code) && nested.code > 0 && nested.code < grpcStatuses.length) rpcStatus = grpcStatuses[nested.code];
    if (guardReasons.has(nested.details)) guardReason = nested.details;
    nested = Array.isArray(nested) ? nested[2]?.err : nested.err;
  }
  const knownErrors = new Set(['UnknownWorkerAction']);
  const bosReason = Array.isArray(error) && typeof error[1] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(error[1]) ? error[1] : undefined;
  const reason = bosReason || (knownErrors.has(error?.message) ? error.message : 'BosWorkerError');
  const errorType = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError'].includes(error?.name) ? error.name : undefined;
  const code = typeof error?.code === 'string' && /^(?:ERR_[A-Z_]+|MODULE_NOT_FOUND|ENOENT|EACCES|ECONNREFUSED)$/.test(error.code) ? error.code : undefined;
  const location = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1).join('\n').match(/([\w-]+\.(?:c?js|mjs):\d+:\d+)/)?.[1] : undefined;
  return { ok: false, reason, diagnostics: { stage, bunVersion, errorType, code, location, rpcStatus, guardReason } };
}

module.exports = { workerFailure };
