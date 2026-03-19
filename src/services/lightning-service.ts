/**
 * LND REST client for Lightning Network invoice payment and creation.
 * Uses Node.js built-in https module for all requests (handles self-signed TLS certs).
 */

import * as https from 'node:https';
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { Config } from '../config.js';
import type { LndPayInvoiceResponse, LndAddInvoiceResponse } from '../types.js';

/** Maximum time (ms) to wait for an LND request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum response body size (bytes) accepted from LND. */
const RESPONSE_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MB

export type PaymentErrorCode =
  | 'PAYMENT_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_ROUTE';

export class PaymentError extends Error {
  public readonly code: PaymentErrorCode;

  constructor(message: string, code: PaymentErrorCode) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

function sanitiseLndBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const SENSITIVE_FIELDS = ['payment_preimage', 'payment_hash', 'r_hash', 'r_preimage'];
    for (const field of SENSITIVE_FIELDS) {
      if (field in parsed) parsed[field] = '[REDACTED]';
    }
    return JSON.stringify(parsed).slice(0, 256);
  } catch {
    return body.slice(0, 256);
  }
}

export class LightningService {
  private readonly baseUrl: URL;
  private readonly macaroonHex: string;
  private readonly tlsAgent?: https.Agent;

  constructor(private readonly config: Config) {
    this.baseUrl = new URL(config.lndRestUrl);
    this.macaroonHex = config.lndMacaroonHex;

    // Warn if the LND connection is plaintext — the admin macaroon would be
    // transmitted unencrypted, granting full node control to any observer.
    if (this.baseUrl.protocol === 'http:') {
      console.warn(
        '[LightningService] WARNING: LND_REST_URL uses http:// — ' +
          'the admin macaroon will be sent in cleartext. ' +
          'Use https:// with LND_TLS_CERT_PATH for all non-loopback connections.',
      );
    }

    // If a TLS cert path is provided, load it into a custom HTTPS agent so
    // that self-signed certificates (the LND default) are accepted.
    // Without this, Node.js TLS will reject self-signed certs even over https://.
    // For local development with Polar, set LND_TLS_CERT_PATH to the node's
    // tls.cert file (typically ~/.polar/networks/<id>/volumes/lnd/<node>/tls.cert).
    if (config.lndTlsCertPath) {
      const cert = fs.readFileSync(config.lndTlsCertPath);
      this.tlsAgent = new https.Agent({
        ca: cert,
        rejectUnauthorized: true,
      });
    }
  }

  /**
   * Pay a BOLT11 Lightning invoice.
   * Returns the hex-encoded preimage and payment hash.
   */
  async payInvoice(
    bolt11: string,
  ): Promise<{ preimage: string; paymentHash: string }> {
    const response = await this.lndRequest<LndPayInvoiceResponse>(
      '/v1/channels/transactions',
      'POST',
      { payment_request: bolt11 },
    );

    if (!response.payment_preimage) {
      throw new PaymentError(
        'LND returned empty payment preimage — payment may have failed',
        'PAYMENT_FAILED',
      );
    }

    // WARNING-7: Validate preimage is exactly 32 bytes
    const preimageBytes = Buffer.from(response.payment_preimage, 'base64');
    if (preimageBytes.length !== 32) {
      throw new PaymentError(
        `Malformed preimage: expected 32 bytes, got ${preimageBytes.length}`,
        'PAYMENT_FAILED',
      );
    }

    return {
      preimage: preimageBytes.toString('hex'),
      paymentHash: this.decodeBase64ToHex(response.payment_hash),
    };
  }

  /**
   * Create a Lightning invoice on the local LND node.
   * Used for receiving refund payments.
   */
  async createInvoice(
    amountSats: number,
    memo?: string,
  ): Promise<{ bolt11: string; rHash: string }> {
    const body: Record<string, unknown> = { value: String(amountSats) };
    if (memo) {
      body.memo = memo;
    }

    const response = await this.lndRequest<LndAddInvoiceResponse>(
      '/v1/invoices',
      'POST',
      body,
    );

    return {
      bolt11: response.payment_request,
      rHash: this.decodeBase64ToHex(response.r_hash),
    };
  }

  /**
   * Decode a base64-encoded string to hex.
   */
  private decodeBase64ToHex(b64: string): string {
    return Buffer.from(b64, 'base64').toString('hex');
  }

  /**
   * Make an authenticated request to the LND REST API.
   * Uses Node.js built-in https/http module to support custom TLS agents.
   */
  private lndRequest<T>(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';

      const requestBody = body ? JSON.stringify(body) : undefined;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Grpc-Metadata-Macaroon': this.macaroonHex,
          'Content-Type': 'application/json',
          ...(requestBody
            ? { 'Content-Length': Buffer.byteLength(requestBody) }
            : {}),
        },
        ...(isHttps && this.tlsAgent ? { agent: this.tlsAgent } : {}),
      };

      const transport = isHttps ? https : http;
      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > RESPONSE_SIZE_LIMIT) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (streamError) => {
          reject(
            new PaymentError(
              `LND response stream error: ${streamError.message}`,
              'PAYMENT_FAILED',
            ),
          );
        });
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');

          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            const errorCode = this.mapLndErrorCode(responseBody);
            console.debug(`[LightningService] LND error response: ${sanitiseLndBody(responseBody)}`);
            reject(
              new PaymentError(
                `LND request failed: HTTP ${res.statusCode ?? 'unknown'} (${errorCode})`,
                errorCode,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(responseBody) as T);
          } catch {
            console.debug(`[LightningService] Unparseable LND response: ${sanitiseLndBody(responseBody)}`);
            reject(
              new PaymentError(
                'Failed to parse LND response as JSON',
                'PAYMENT_FAILED',
              ),
            );
          }
        });
      });

      req.on('error', (error) => {
        // Handle timeout-specific errors
        if (error.message.includes('timed out')) {
          reject(
            new PaymentError(
              'LND request timed out',
              'PAYMENT_FAILED',
            ),
          );
          return;
        }
        // Handle response-too-large errors
        if (error.message.includes('Response too large')) {
          reject(
            new PaymentError(
              'LND response exceeded size limit',
              'PAYMENT_FAILED',
            ),
          );
          return;
        }
        reject(
          new PaymentError(
            `LND connection error: ${error.message}`,
            'PAYMENT_FAILED',
          ),
        );
      });

      // BLOCKER-4: Request timeout
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('LND request timed out after 30s'));
      });

      if (requestBody) {
        req.write(requestBody);
      }
      req.end();
    });
  }

  /**
   * Attempt to map LND error response bodies to specific error codes.
   */
  private mapLndErrorCode(responseBody: string): PaymentErrorCode {
    const lower = responseBody.toLowerCase();
    if (
      lower.includes('insufficient') ||
      lower.includes('not enough balance')
    ) {
      return 'INSUFFICIENT_BALANCE';
    }
    if (lower.includes('no route') || lower.includes('unable to find a path')) {
      return 'NO_ROUTE';
    }
    return 'PAYMENT_FAILED';
  }
}
