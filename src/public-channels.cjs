// Apply the policy at the RPC boundary so BOS's own liquidity refreshes also
// request public channels only, including when a peer has both channel types.
function publicChannelsOnly(lnd) {
  const listChannels = lnd.default.listChannels.bind(lnd.default);
  lnd.default.listChannels = (request, ...args) => {
    const callback = args.pop();
    return listChannels({ ...request, public_only: true, private_only: false }, ...args, (error, response) => {
      if (error || !Array.isArray(response?.channels)) return callback(error, response);
      callback(null, { ...response, channels: response.channels.filter(channel => channel.private === false) });
    });
  };

  // PendingChannels has no public-only request filter. BOS uses it for summary
  // information, so omit that inventory rather than reading private channels.
  lnd.default.pendingChannels = (_request, callback) => {
    queueMicrotask(() => callback(null, {
      total_limbo_balance: '0', pending_open_channels: [],
      pending_closing_channels: [], pending_force_closing_channels: [],
      waiting_close_channels: [],
    }));
  };
}

module.exports = { publicChannelsOnly };
