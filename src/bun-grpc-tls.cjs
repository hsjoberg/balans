// grpc-js supplies IP literals as TLS SNI names; Bun rejects these because SNI
// requires a hostname. Omit only that SNI value and still verify the original IP.
// This shim is confined to the isolated BOS worker and HTTP/2 TLS connections.
const tls = require('node:tls');
const { isIP } = require('node:net');
const connect = tls.connect;

tls.connect = function (options, ...rest) {
  if (options && typeof options === 'object' && isIP(options.servername || '') && options.ALPNProtocols?.includes('h2')) {
    const expectedHost = options.servername;
    const verify = options.checkServerIdentity || tls.checkServerIdentity;
    options = {
      ...options,
      servername: undefined,
      checkServerIdentity: (_host, cert) => verify(expectedHost, cert),
    };
  }
  return connect.call(this, options, ...rest);
};
