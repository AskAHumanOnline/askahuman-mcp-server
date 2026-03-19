/**
 * L402 credential management.
 * Handles the pay-to-authenticate flow: obtains a 402 challenge,
 * pays the Lightning invoice, and returns the credentials for authenticated requests.
 */

import type { AskAHumanClient } from './askahuman-client.js';
import type { LightningService } from './lightning-service.js';
import type { CreateVerificationRequest } from '../types.js';

/**
 * Opaque wrapper for L402 credentials. The preimage is stored non-enumerable
 * so it won't appear in JSON.stringify, Object.keys, or console.log output.
 */
export class L402Credentials {
  public readonly macaroon: string;
  public readonly verificationId: string;
  private readonly _preimage!: string;

  constructor(macaroon: string, preimage: string, verificationId: string) {
    this.macaroon = macaroon;
    this.verificationId = verificationId;
    Object.defineProperty(this, '_preimage', {
      value: preimage,
      enumerable: false,
      writable: false,
    });
  }

  /** Returns the preimage for use in Authorization headers only. */
  getPreimage(): string { return this._preimage; }

  toJSON(): Record<string, unknown> {
    return { macaroon: this.macaroon, verificationId: this.verificationId, preimage: '[REDACTED]' };
  }
}

export class L402Service {
  constructor(
    private readonly client: AskAHumanClient,
    private readonly lightning: LightningService,
  ) {}

  /**
   * Authenticate a verification request via the L402 payment flow.
   *
   * 1. Submit the request to get a 402 challenge (macaroon + Lightning invoice)
   * 2. Pay the invoice via the configured LND node
   * 3. Return credentials for the authenticated retry
   *
   * Each verification request is a fresh payment -- no caching at this level.
   */
  async authenticate(
    req: CreateVerificationRequest,
  ): Promise<L402Credentials> {
    // Step 1: Get the 402 challenge with macaroon and invoice
    const challenge = await this.client.createVerificationRequest(req);

    // WARNING-8: Enforce maxBudgetSats before paying
    if (req.maxBudgetSats !== undefined && challenge.amountSats > req.maxBudgetSats) {
      throw new Error(
        `Server is requesting ${challenge.amountSats} sats but agent maxBudgetSats is ${req.maxBudgetSats}. Refusing payment.`,
      );
    }

    // Step 2: Pay the Lightning invoice
    const payment = await this.lightning.payInvoice(challenge.invoice);

    // Step 3: Return credentials for the authenticated retry
    return new L402Credentials(
      challenge.macaroon,
      payment.preimage,
      challenge.verificationId,
    );
  }
}
