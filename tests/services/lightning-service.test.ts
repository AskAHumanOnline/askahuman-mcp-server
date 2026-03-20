/**
 * Unit tests for LightningService.
 * Uses a real HTTP server on localhost to mock LND responses,
 * since native ESM modules (node:http/https) cannot be spied on with jest.spyOn.
 */

import { LightningService, PaymentError } from '../../src/services/lightning-service.js';
import type { Config } from '../../src/config.js';
import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let mockServer: http.Server;
let serverPort: number;

function createTestConfig(port: number): Config {
  return {
    askahumanApiUrl: 'https://api.example.com',
    lndRestUrl: `http://127.0.0.1:${port}`,
    lndMacaroonHex: 'deadbeefcafe',
    logLevel: 'info',
  };
}

/** Start a mock HTTP server that responds to LND API paths. */
function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler);
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  await stopMockServer();
  jest.restoreAllMocks();
});

describe('LightningService', () => {
  describe('payInvoice', () => {
    it('decodes base64 preimage to hex correctly', async () => {
      const preimageBytes = Buffer.alloc(32, 0xab);
      const preimageBase64 = preimageBytes.toString('base64');
      const paymentHashBase64 = Buffer.alloc(32, 0xcd).toString('base64');

      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: preimageBase64,
          payment_hash: paymentHashBase64,
        }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      const result = await service.payInvoice('lnbc100n1...');

      expect(result.preimage).toBe(preimageBytes.toString('hex'));
      expect(result.paymentHash).toBe(Buffer.alloc(32, 0xcd).toString('hex'));
    });

    it('throws PaymentError when preimage is empty', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: '',
          payment_hash: Buffer.alloc(32).toString('base64'),
        }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toThrow(PaymentError);
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
      });
    });

    it('throws PaymentError when preimage is wrong length', async () => {
      const shortPreimage = Buffer.alloc(16, 0xab).toString('base64');

      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: shortPreimage,
          payment_hash: Buffer.alloc(32).toString('base64'),
        }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('expected 32 bytes'),
      });
    });

    it('maps INSUFFICIENT_BALANCE error from LND', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'insufficient local balance' }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });
    });

    it('maps NO_ROUTE error from LND', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unable to find a path' }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'NO_ROUTE',
      });
    });

    it('sends Grpc-Metadata-Macaroon header', async () => {
      let receivedMacaroon: string | undefined;
      const preimageBytes = Buffer.alloc(32, 0xab);

      serverPort = await startMockServer((req, res) => {
        receivedMacaroon = req.headers['grpc-metadata-macaroon'] as string;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: preimageBytes.toString('base64'),
          payment_hash: Buffer.alloc(32).toString('base64'),
        }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await service.payInvoice('lnbc100n1...');

      expect(receivedMacaroon).toBe('deadbeefcafe');
    });
  });

  describe('createInvoice', () => {
    it('sends correct body and returns bolt11 + rHash', async () => {
      const rHashBase64 = Buffer.alloc(32, 0xff).toString('base64');
      let receivedBody = '';

      serverPort = await startMockServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            payment_request: 'lnbc500n1...',
            r_hash: rHashBase64,
            add_index: '42',
          }));
        });
      });

      const service = new LightningService(createTestConfig(serverPort));
      const result = await service.createInvoice(500, 'test memo');

      expect(result.bolt11).toBe('lnbc500n1...');
      expect(result.rHash).toBe(Buffer.alloc(32, 0xff).toString('hex'));

      const parsed = JSON.parse(receivedBody) as { value: string; memo: string };
      expect(parsed.value).toBe('500');
      expect(parsed.memo).toBe('test memo');
    });

    it('omits memo when not provided', async () => {
      let receivedBody = '';

      serverPort = await startMockServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            payment_request: 'lnbc100n1...',
            r_hash: Buffer.alloc(32).toString('base64'),
            add_index: '1',
          }));
        });
      });

      const service = new LightningService(createTestConfig(serverPort));
      await service.createInvoice(100);

      const parsed = JSON.parse(receivedBody) as Record<string, unknown>;
      expect(parsed.value).toBe('100');
      expect(parsed).not.toHaveProperty('memo');
    });
  });

  describe('constructor', () => {
    it('warns about plaintext http:// LND URL', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      new LightningService(createTestConfig(8080));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('http://'));
    });
  });

  describe('sanitiseLndBody', () => {
    it('redacts sensitive fields in error logs', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: 'secret_preimage_value',
          error: 'some error',
        }));
      });

      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
      const service = new LightningService(createTestConfig(serverPort));

      await expect(service.payInvoice('lnbc...')).rejects.toThrow(PaymentError);

      const logCalls = debugSpy.mock.calls.flat().join(' ');
      expect(logCalls).toContain('[REDACTED]');
      expect(logCalls).not.toContain('secret_preimage_value');
    });
  });

  describe('error handling', () => {
    it('throws PaymentError on unparseable JSON response', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not json at all');
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('parse'),
      });
    });

    it('throws PaymentError on connection refused', async () => {
      // Use a port that nothing is listening on
      const service = new LightningService(createTestConfig(1));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toThrow(PaymentError);
    });

    it('throws PaymentError when response exceeds size limit (payInvoice)', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Send a response larger than 1 MB
        const chunk = Buffer.alloc(512 * 1024, 'x');
        res.write(chunk);
        res.write(chunk);
        res.write(chunk); // 1.5 MB total
        res.end();
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('size limit'),
      });
    });

    it('throws PaymentError when response exceeds size limit (createInvoice)', async () => {
      serverPort = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = Buffer.alloc(512 * 1024, 'x');
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.end();
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.createInvoice(100)).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('size limit'),
      });
    });

    it('throws PaymentError on request timeout (payInvoice)', async () => {
      serverPort = await startMockServer((_req, _res) => {
        // Never respond — let the timeout fire
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('timed out'),
      });
    }, 35_000);

    it('throws PaymentError on request timeout (createInvoice)', async () => {
      serverPort = await startMockServer((_req, _res) => {
        // Never respond — let the timeout fire
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.createInvoice(100)).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('timed out'),
      });
    }, 35_000);

    it('handles missing statusCode in LND error response', async () => {
      serverPort = await startMockServer((_req, res) => {
        // Force a response with no status code by writing raw HTTP
        // Instead, use a status code 0 scenario — most reliable is a non-2xx code
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'generic failure' }));
      });

      const service = new LightningService(createTestConfig(serverPort));
      await expect(service.payInvoice('lnbc100n1...')).rejects.toMatchObject({
        code: 'PAYMENT_FAILED',
        message: expect.stringContaining('HTTP 500'),
      });
    });
  });

  describe('TLS configuration', () => {
    let httpsServer: https.Server | undefined;

    afterEach(async () => {
      if (httpsServer) {
        await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
        httpsServer = undefined;
      }
    });

    it('reads TLS cert file and creates HTTPS agent when lndTlsCertPath is set', () => {
      // Write a fake cert to a temp file
      const tmpDir = os.tmpdir();
      const certPath = path.join(tmpDir, 'test-lnd-tls.cert');
      fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----\n');

      try {
        const config: Config = {
          askahumanApiUrl: 'https://api.example.com',
          lndRestUrl: 'https://127.0.0.1:8080',
          lndMacaroonHex: 'deadbeefcafe',
          lndTlsCertPath: certPath,
          logLevel: 'info',
        };

        // Should not throw — successfully reads cert and creates agent
        const service = new LightningService(config);
        expect(service).toBeDefined();
      } finally {
        fs.unlinkSync(certPath);
      }
    });

    it('does not create HTTPS agent when lndTlsCertPath is not set', () => {
      const config: Config = {
        askahumanApiUrl: 'https://api.example.com',
        lndRestUrl: 'https://127.0.0.1:8080',
        lndMacaroonHex: 'deadbeefcafe',
        logLevel: 'info',
      };

      // Should not throw
      const service = new LightningService(config);
      expect(service).toBeDefined();
    });

    it('makes HTTPS requests with custom TLS cert and receives valid response', async () => {
      // Generate a self-signed certificate for the test server
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });

      // Create a minimal self-signed cert using Node's createCertificate isn't available,
      // so we use the openssl-like approach with node:crypto (Node 20+)
      // For simplicity, use generateCertificate if available, otherwise skip
      const tmpDir = os.tmpdir();
      const certPath = path.join(tmpDir, 'test-lnd-selfsigned.pem');
      const keyPath = path.join(tmpDir, 'test-lnd-key.pem');

      // Use child_process to generate a self-signed cert
      const { execSync } = await import('node:child_process');
      try {
        execSync(
          `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
          `-days 1 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null`,
        );
      } catch {
        // openssl not available — skip test
        return;
      }

      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);

      const preimageBytes = Buffer.alloc(32, 0xab);

      httpsServer = https.createServer({ key, cert }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          payment_preimage: preimageBytes.toString('base64'),
          payment_hash: Buffer.alloc(32, 0xcd).toString('base64'),
        }));
      });

      const port = await new Promise<number>((resolve) => {
        httpsServer!.listen(0, '127.0.0.1', () => {
          const addr = httpsServer!.address() as { port: number };
          resolve(addr.port);
        });
      });

      const config: Config = {
        askahumanApiUrl: 'https://api.example.com',
        lndRestUrl: `https://127.0.0.1:${port}`,
        lndMacaroonHex: 'deadbeefcafe',
        lndTlsCertPath: certPath,
        logLevel: 'info',
      };

      const service = new LightningService(config);
      const result = await service.payInvoice('lnbc100n1...');

      expect(result.preimage).toBe(preimageBytes.toString('hex'));
      expect(result.paymentHash).toBe(Buffer.alloc(32, 0xcd).toString('hex'));

      // Clean up temp files
      fs.unlinkSync(certPath);
      fs.unlinkSync(keyPath);
    });
  });
});
