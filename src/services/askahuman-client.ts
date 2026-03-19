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

export type AskAHumanErrorCode =
  | 'PAYMENT_REQUIRED_UNEXPECTED'
  | 'API_ERROR'
  | 'NETWORK_ERROR';

export class AskAHumanError extends Error {
  public readonly code: AskAHumanErrorCode;
  public readonly status?: number;
  public readonly body?: string;

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
    this.body = body;
  }
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
      throw new AskAHumanError(
        `Failed to get verification ${id}: HTTP ${response.status}`,
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
      throw new AskAHumanError(
        `Expected 402 Payment Required but got ${response.status}`,
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
      throw new AskAHumanError(
        `Could not parse L402 credentials from WWW-Authenticate header: "${wwwAuth}"`,
        'API_ERROR',
        402,
        JSON.stringify(responseBody),
      );
    }

    if (!verificationId) {
      throw new AskAHumanError(
        'Missing verificationId in 402 response body',
        'API_ERROR',
        402,
        JSON.stringify(responseBody),
      );
    }

    return {
      verificationId,
      macaroon: credentials.macaroon,
      invoice: credentials.invoice,
      amountSats: totalInvoiceSats ?? amountSats ?? 0,
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
      throw new AskAHumanError(
        'Server returned 402 despite L402 credentials — payment may not have been recognized',
        'PAYMENT_REQUIRED_UNEXPECTED',
        402,
        body,
      );
    }

    if (!response.ok) {
      const body = await this.safeReadBody(response);
      throw new AskAHumanError(
        `Verification submission failed: HTTP ${response.status}`,
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
      throw new AskAHumanError(
        `Refund request failed: HTTP ${response.status}`,
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
      throw new AskAHumanError(
        `Failed to get pricing: HTTP ${response.status}`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    return (await response.json()) as PricingResponse;
  }

  /**
   * Internal fetch wrapper that catches network errors and normalizes them.
   */
  private async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, init);
    } catch (error) {
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
