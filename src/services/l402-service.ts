/**
 * L402 credential management.
 * Handles the pay-to-authenticate flow: obtains a 402 challenge,
 * pays the Lightning invoice, and returns the credentials for authenticated requests.
 */

import type { AskAHumanClient } from './askahuman-client.js';
import type { LightningService } from './lightning-service.js';
import type { CreateVerificationRequest } from '../types.js';

export interface L402Credentials {
  macaroon: string;
  preimage: string;
  verificationId: string;
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

    // Step 2: Pay the Lightning invoice
    const payment = await this.lightning.payInvoice(challenge.invoice);

    // Step 3: Return credentials for the authenticated retry
    return {
      macaroon: challenge.macaroon,
      preimage: payment.preimage,
      verificationId: challenge.verificationId,
    };
  }
}
