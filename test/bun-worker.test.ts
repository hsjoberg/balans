import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Use the exact transport/proto dependencies loaded by BOS, not another version.
const bosRequire = createRequire(require.resolve('balanceofsatoshis/package.json'));
const lnRequire = createRequire(bosRequire.resolve('ln-service'));
const lightningRequire = createRequire(lnRequire.resolve('lightning'));
const grpc = lightningRequire('@grpc/grpc-js');
const loader = lightningRequire('@grpc/proto-loader');
const proto = join(dirname(lnRequire.resolve('lightning/package.json')), 'grpc/protos/lightning.proto');

test.each([
  { label: 'reads via IP address', host: '127.0.0.1', serverCert: 'lnd-test-cert.pem', trustedCert: 'lnd-test-cert.pem', succeeds: true },
  { label: 'reads via hostname', host: 'localhost', serverCert: 'lnd-test-cert.pem', trustedCert: 'lnd-test-cert.pem', succeeds: true },
  { label: 'rejects a trusted certificate for the wrong host', host: '127.0.0.1', serverCert: 'lnd-wrong-host-cert.pem', trustedCert: 'lnd-wrong-host-cert.pem', succeeds: false },
  { label: 'rejects an untrusted certificate', host: '127.0.0.1', serverCert: 'lnd-test-cert.pem', trustedCert: 'lnd-wrong-host-cert.pem', succeeds: false },
])('Bun BOS adapter $label over TLS gRPC without Node on PATH', async ({ host, serverCert, trustedCert, succeeds }) => {
  // Public, test-only TLS identity. Never use these fixtures for an actual node.
  const key = readFileSync(new URL('./fixtures/lnd-test-key.pem', import.meta.url));
  const cert = readFileSync(new URL(`./fixtures/${serverCert}`, import.meta.url));
  const trusted = readFileSync(new URL(`./fixtures/${trustedCert}`, import.meta.url));
  const definition = loader.loadSync(proto, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const { lnrpc } = grpc.loadPackageDefinition(definition);
  const server = new grpc.Server();
  let calls = 0;
  let macaroon: unknown;
  let channelRequest: any;
  server.addService(lnrpc.Lightning.service, {
    listChannels(call: any, callback: any) {
      calls++;
      macaroon = call.metadata.get('macaroon')[0];
      channelRequest = call.request;
      callback(null, { channels: [] });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), 'balans-bun-grpc-'));
  const savedNode = join(directory, 'test-node');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }]), (error: Error | null, port: number) => error ? reject(error) : resolve(port)));
    mkdirSync(savedNode);
    writeFileSync(join(savedNode, 'credentials.json'), JSON.stringify({ socket: `${host}:${port}`, cert: trusted.toString('base64'), macaroon: '00' }));
    // Exercise the public adapter too: it must launch its worker using Bun even
    // when neither a node nor bun command is discoverable through PATH.
    child = Bun.spawn([process.execPath, '-e', `
      import { bosBackend } from './src/bos.ts';
      try { console.log(JSON.stringify({ok: true, result: await bosBackend('test-node').snapshot()})); }
      catch (error) { console.log(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; }
    `], {
      env: { ...process.env, PATH: '', BOS_DATA_PATH: directory },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited,
    ]);
    const response = JSON.parse(stdout);
    if (succeeds) {
      expect({ code, response }).toEqual({ code: 0, response: { ok: true, result: [] } });
      expect(stderr).not.toContain('error:');
      expect(calls).toBe(1);
      expect(macaroon).toBe('00');
      expect(channelRequest.public_only).toBe(true);
      expect(channelRequest.private_only).toBe(false);
    } else {
      expect(code).toBe(1);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('UnexpectedGetChannelsError');
      expect(response.error).toContain(`Bun: ${Bun.version}`);
      expect(calls).toBe(0);
    }
  } finally {
    child?.kill();
    server.forceShutdown();
    // Remove only these known test files and empty temporary directories.
    try { unlinkSync(join(savedNode, 'credentials.json')); } catch {}
    try { rmdirSync(savedNode); } catch {}
    rmdirSync(directory);
  }
}, 15_000);
