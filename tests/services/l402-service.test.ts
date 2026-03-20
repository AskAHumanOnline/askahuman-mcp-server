/**
 * Unit tests for L402Service and L402Credentials.
 */

import { L402Service, L402Credentials } from '../../src/services/l402-service.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import type { LightningService } from '../../src/services/lightning-service.js';
import { PaymentError } from '../../src/services/lightning-service.js';
import { TaskType, type PaymentChallenge } from '../../src/types.js';

function createMockClient(): jest.Mocked<Pick<AskAHumanClient, 'createVerificationRequest'>> {
  return {
    createVerificationRequest: jest.fn(),
  };
}

function createMockLightning(): jest.Mocked<Pick<LightningService, 'payInvoice'>> {
  return {
    payInvoice: jest.fn(),
  };
}

describe('L402Credentials', () => {
  it('stores macaroon and verificationId as accessible properties', () => {
    const creds = new L402Credentials('mac123', 'pre456', 'vid789');
    expect(creds.macaroon).toBe('mac123');
    expect(creds.verificationId).toBe('vid789');
  });

  it('exposes preimage via getPreimage() accessor', () => {
    const creds = new L402Credentials('mac', 'mypreimage', 'vid');
    expect(creds.getPreimage()).toBe('mypreimage');
  });

  it('does not include preimage in JSON.stringify output', () => {
    const creds = new L402Credentials('mac', 'secret-preimage', 'vid');
    const json = JSON.stringify(creds);
    expect(json).not.toContain('secret-preimage');
    expect(json).toContain('[REDACTED]');
  });

  it('does not include _preimage in Object.keys', () => {
    const creds = new L402Credentials('mac', 'secret', 'vid');
    expect(Object.keys(creds)).not.toContain('_preimage');
  });

  it('toJSON returns expected shape', () => {
    const creds = new L402Credentials('mac', 'pre', 'vid');
    const json = creds.toJSON();
    expect(json).toEqual({
      macaroon: 'mac',
      verificationId: 'vid',
      preimage: '[REDACTED]',
    });
  });
});

describe('L402Service', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockLightning: ReturnType<typeof createMockLightning>;
  let service: L402Service;

  beforeEach(() => {
    mockClient = createMockClient();
    mockLightning = createMockLightning();
    service = new L402Service(
      mockClient as unknown as AskAHumanClient,
      mockLightning as unknown as LightningService,
    );
  });

  describe('authenticate', () => {
    const req = {
      agentId: 'test',
      taskType: TaskType.BINARY_DECISION,
      taskData: { question: 'Is this spam?' },
    };

    it('calls createVerificationRequest then payInvoice', async () => {
      const challenge: PaymentChallenge = {
        verificationId: 'vid-123',
        macaroon: 'mac-456',
        invoice: 'lnbc100n1...',
        amountSats: 25,
      };

      mockClient.createVerificationRequest.mockResolvedValue(challenge);
      mockLightning.payInvoice.mockResolvedValue({
        preimage: 'hex-preimage-789',
        paymentHash: 'hash-abc',
      });

      const creds = await service.authenticate(req);

      expect(mockClient.createVerificationRequest).toHaveBeenCalledWith(req);
      expect(mockLightning.payInvoice).toHaveBeenCalledWith('lnbc100n1...');
      expect(creds).toBeInstanceOf(L402Credentials);
      expect(creds.macaroon).toBe('mac-456');
      expect(creds.verificationId).toBe('vid-123');
      expect(creds.getPreimage()).toBe('hex-preimage-789');
    });

    it('returns credentials with accessible fields', async () => {
      mockClient.createVerificationRequest.mockResolvedValue({
        verificationId: 'vid', macaroon: 'mac', invoice: 'inv', amountSats: 25,
      });
      mockLightning.payInvoice.mockResolvedValue({
        preimage: 'pre', paymentHash: 'hash',
      });

      const creds = await service.authenticate(req);
      expect(creds.macaroon).toBe('mac');
      expect(creds.verificationId).toBe('vid');
      expect(creds.getPreimage()).toBe('pre');
    });

    it('propagates payInvoice failure', async () => {
      mockClient.createVerificationRequest.mockResolvedValue({
        verificationId: 'vid', macaroon: 'mac', invoice: 'inv', amountSats: 25,
      });
      mockLightning.payInvoice.mockRejectedValue(
        new PaymentError('no route found', 'NO_ROUTE'),
      );

      await expect(service.authenticate(req)).rejects.toThrow(PaymentError);
      await expect(service.authenticate(req)).rejects.toMatchObject({
        code: 'NO_ROUTE',
      });
    });

    it('refuses payment when amountSats exceeds maxBudgetSats', async () => {
      mockClient.createVerificationRequest.mockResolvedValue({
        verificationId: 'vid', macaroon: 'mac', invoice: 'inv', amountSats: 100,
      });

      const reqWithBudget = { ...req, maxBudgetSats: 50 };
      await expect(service.authenticate(reqWithBudget)).rejects.toThrow(
        /Server is requesting 100 sats but agent maxBudgetSats is 50/,
      );

      // payInvoice should NOT have been called
      expect(mockLightning.payInvoice).not.toHaveBeenCalled();
    });

    it('allows payment when amountSats is within maxBudgetSats', async () => {
      mockClient.createVerificationRequest.mockResolvedValue({
        verificationId: 'vid', macaroon: 'mac', invoice: 'inv', amountSats: 25,
      });
      mockLightning.payInvoice.mockResolvedValue({
        preimage: 'pre', paymentHash: 'hash',
      });

      const reqWithBudget = { ...req, maxBudgetSats: 50 };
      const creds = await service.authenticate(reqWithBudget);
      expect(creds).toBeInstanceOf(L402Credentials);
    });
  });
});
