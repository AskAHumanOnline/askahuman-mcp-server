/**
 * HTTP client wrapping the AskAHuman REST API.
 * Uses native fetch (Node.js 18+).
 */

import type { Config } from '../config.js';
import type {
  CreateVerificationRequest,
  PaymentChallenge,
  PricingResponse,
  VerificationResponse,
} from '../types.js';

/** Maximum time (ms) to wait for any single API request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum acceptable length for macaroon or invoice values. */
const MAX_CREDENTIAL_LENGTH = 8192;

/** Regex for validating UUID format. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AskAHumanErrorCode =
  | 'PAYMENT_REQUIRED_UNEXPECTED'
  | 'API_ERROR'
  | 'NETWORK_ERROR';

export class AskAHumanError extends Error {
  public readonly code: AskAHumanErrorCode;
  public readonly status?: number;
  // Keep body non-enumerable so JSON.stringify(err) doesn't leak it
  private readonly _body?: string;

  constructor(
    message: string,
    code: AskAHumanErrorCode,
    status?: number,
    body?: string,
  ) {
    super(message);
    this.name = 'AskAHumanError';
    this.code = code;
    this.status = status;
    Object.defineProperty(this, '_body', { value: body, enumerable: false, writable: false });
  }

  get body(): string | undefined { return this._body; }
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 * Used to sanitise response bodies before including in debug logs.
 */
function sanitiseBody(raw: string, maxLength = 256): string {
  if (raw.length <= maxLength) return raw;
  return raw.slice(0, maxLength) + '...[truncated]';
}

/**
 * Parse the WWW-Authenticate header from a 402 response.
 *
 * Supports two formats:
 *   1. `L402 <macaroon>:<invoice>` (colon-separated)
 *   2. `L402 macaroon="...", invoice="..."` (named parameters)
 */
function parseWwwAuthenticate(header: string): {
  macaroon: string;
  invoice: string;
} | null {
  // Format 1: L402 <macaroon>:<invoice>
  const colonMatch = header.match(/^L402\s+([^:,\s]+):([^,\s]+)/);
  if (colonMatch) {
    return { macaroon: colonMatch[1], invoice: colonMatch[2] };
  }

  // Format 2: L402 macaroon="...", invoice="..."
  const macaroonMatch = header.match(/macaroon="([^"]+)"/i);
  const invoiceMatch = header.match(/invoice="([^"]+)"/i);
  if (macaroonMatch && invoiceMatch) {
    return { macaroon: macaroonMatch[1], invoice: invoiceMatch[1] };
  }

  return null;
}

export class AskAHumanClient {
  private readonly baseUrl: string;

  constructor(config: Config) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = config.askahumanApiUrl.replace(/\/+$/, '');
  }

  /**
   * Get the status and result of a verification request.
   */
  async getVerification(id: string): Promise<VerificationResponse> {
    const response = await this.fetch(`/api/verify/${encodeURIComponent(id)}`);

    if (!response.ok) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] GET /api/verify/${id} failed: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        `AskAHuman API error: HTTP ${response.status} (API_ERROR)`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    return (await response.json()) as VerificationResponse;
  }

  /**
   * Submit a new verification request. Expects a 402 Payment Required response
   * containing a macaroon and Lightning invoice.
   */
  async createVerificationRequest(
    req: CreateVerificationRequest,
  ): Promise<PaymentChallenge> {
    const response = await this.fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });

    if (response.status !== 402) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] POST /api/verify unexpected status: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        `AskAHuman API error: HTTP ${response.status} (PAYMENT_REQUIRED_UNEXPECTED)`,
        'PAYMENT_REQUIRED_UNEXPECTED',
        response.status,
        body,
      );
    }

    // Parse credentials from WWW-Authenticate header
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? '';
    const credentials = parseWwwAuthenticate(wwwAuth);

    // Also read verification details from the JSON body
    const responseBody = (await response.json()) as Record<string, unknown>;
    const verificationId = responseBody.verificationId as string | undefined;
    const amountSats = responseBody.amountSats as number | undefined;
    const totalInvoiceSats = responseBody.totalInvoiceSats as
      | number
      | undefined;

    if (!credentials) {
      const bodyStr = JSON.stringify(responseBody);
      console.debug(`[AskAHumanClient] Failed to parse WWW-Authenticate: ${sanitiseBody(bodyStr)}`);
      throw new AskAHumanError(
        'AskAHuman API error: HTTP 402 (API_ERROR) — could not parse L402 credentials from WWW-Authenticate header',
        'API_ERROR',
        402,
        bodyStr,
      );
    }

    // WARNING-3: Validate credential lengths
    if (credentials.macaroon.length > MAX_CREDENTIAL_LENGTH || credentials.invoice.length > MAX_CREDENTIAL_LENGTH) {
      throw new AskAHumanError(
        'Credential in WWW-Authenticate header exceeds maximum length',
        'API_ERROR',
        402,
      );
    }

    if (!verificationId) {
      const bodyStr = JSON.stringify(responseBody);
      console.debug(`[AskAHumanClient] Missing verificationId in 402 body: ${sanitiseBody(bodyStr)}`);
      throw new AskAHumanError(
        'AskAHuman API error: HTTP 402 (API_ERROR) — missing verificationId in response body',
        'API_ERROR',
        402,
        bodyStr,
      );
    }

    // WARNING-2: Validate verificationId is a UUID
    if (!UUID_REGEX.test(verificationId)) {
      throw new AskAHumanError(
        'Server returned invalid verificationId: expected UUID format',
        'API_ERROR',
        402,
      );
    }

    // WARNING-4: Validate amountSats
    const rawAmount = totalInvoiceSats ?? amountSats;
    if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
      throw new AskAHumanError(
        'Server returned invalid amountSats in 402 response',
        'API_ERROR',
        402,
      );
    }

    return {
      verificationId,
      macaroon: credentials.macaroon,
      invoice: credentials.invoice,
      amountSats: rawAmount,
    };
  }

  /**
   * Submit a verification request with L402 authorization (after payment).
   * Expects 202 Accepted.
   */
  async submitVerificationWithL402(
    req: CreateVerificationRequest,
    macaroon: string,
    preimage: string,
  ): Promise<VerificationResponse> {
    const response = await this.fetch('/api/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `L402 ${macaroon}:${preimage}`,
      },
      body: JSON.stringify(req),
    });

    if (response.status === 402) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] L402 submission returned 402: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        'AskAHuman API error: HTTP 402 (PAYMENT_REQUIRED_UNEXPECTED) — payment may not have been recognized',
        'PAYMENT_REQUIRED_UNEXPECTED',
        402,
        body,
      );
    }

    if (!response.ok) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] L402 submission failed: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        `AskAHuman API error: HTTP ${response.status} (API_ERROR)`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    return (await response.json()) as VerificationResponse;
  }

  /**
   * Request a refund for an expired-unclaimed verification.
   * Requires the BOLT11 refund invoice and the original payment preimage as proof.
   */
  async requestRefund(
    verificationId: string,
    invoice: string,
    preimage: string,
  ): Promise<{ refunded: boolean }> {
    const response = await this.fetch(
      `/api/verify/${encodeURIComponent(verificationId)}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice, preimage }),
      },
    );

    if (!response.ok) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] Refund failed: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        `AskAHuman API error: HTTP ${response.status} (API_ERROR)`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    return { refunded: true };
  }

  /**
   * Get current server-side pricing for verification tasks.
   */
  async getPricing(): Promise<PricingResponse> {
    const response = await this.fetch('/api/pricing');

    if (!response.ok) {
      const body = await this.safeReadBody(response);
      console.debug(`[AskAHumanClient] GET /api/pricing failed: ${sanitiseBody(body)}`);
      throw new AskAHumanError(
        `AskAHuman API error: HTTP ${response.status} (API_ERROR)`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    return (await response.json()) as PricingResponse;
  }

  /**
   * Internal fetch wrapper that catches network errors, applies timeout, and normalizes them.
   */
  private async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Handle timeout specifically
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new AskAHumanError(
          'Request timed out',
          'NETWORK_ERROR',
        );
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AskAHumanError(
          'Request timed out',
          'NETWORK_ERROR',
        );
      }
      const message =
        error instanceof Error ? error.message : String(error);
      throw new AskAHumanError(
        `Network error calling ${url}: ${message}`,
        'NETWORK_ERROR',
      );
    }
  }

  /**
   * Safely read response body as text, returning empty string on failure.
   */
  private async safeReadBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}
