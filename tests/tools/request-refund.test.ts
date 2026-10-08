/**
 * Unit tests for the request_refund tool.
 */

import { registerRequestRefund } from '../../src/tools/request-refund.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import { AskAHumanError } from '../../src/services/askahuman-client.js';
import type { LightningService } from '../../src/services/lightning-service.js';
import { PaymentError } from '../../src/services/lightning-service.js';
import type { CredentialStore } from '../../src/services/credential-store.js';
import { VerificationStatus } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

function createMocks() {
  const client = {
    getVerification: jest.fn(),
    requestRefund: jest.fn(),
  } as unknown as jest.Mocked<AskAHumanClient>;

  const lightning = {
    createInvoice: jest.fn(),
  } as unknown as jest.Mocked<LightningService>;

  const credentialStore = {
    get: jest.fn(),
    getProof: jest.fn().mockReturnValue({ macaroon: 'mac', preimage: 'pre' }),
    getRefundInvoice: jest.fn().mockReturnValue(undefined),
    setRefundInvoice: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<CredentialStore>;

  return { client, lightning, credentialStore };
}

function setupTool(mocks: ReturnType<typeof createMocks>): ToolHandler {
  const { server, getHandler } = createMockServer();
  registerRequestRefund(
    server,
    mocks.client as unknown as AskAHumanClient,
    mocks.lightning as unknown as LightningService,
    mocks.credentialStore as unknown as CredentialStore,
  );
  return getHandler();
}

describe('request_refund tool', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: ToolHandler;

  beforeEach(() => {
    mocks = createMocks();
    handler = setupTool(mocks);
  });

  it('happy path: confirms EXPIRED_UNCLAIMED, creates invoice, submits refund, keeps credential', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('stored-preimage-hex');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...',
      rHash: 'hash123',
    });

    (mocks.client.requestRefund as jest.Mock).mockResolvedValue({ refunded: true });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUNDED');
    expect(parsed.refundedAmountSats).toBe(50);

    // Verify preimage was retrieved from store and passed to requestRefund
    expect(mocks.credentialStore.get).toHaveBeenCalledWith('vid-123');
    expect(mocks.client.requestRefund).toHaveBeenCalledWith(
      'vid-123',
      'lnbc50n1refund...',
      'stored-preimage-hex',
    );

    // Credential is kept until TTL so check_verification can still reach REFUNDED
    expect(mocks.credentialStore.delete).not.toHaveBeenCalled();
  });

  it('returns NOT_ELIGIBLE if status is not EXPIRED_UNCLAIMED', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('NOT_ELIGIBLE');
    expect(parsed.failureReason).toContain('COMPLETED');
  });

  it('returns REFUND_WINDOW_EXPIRED when refundEligible is false', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: false,
      totalInvoiceSats: 50,
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('REFUND_WINDOW_EXPIRED');
  });

  it('returns CREDENTIAL_EXPIRED if preimage not in store', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue(undefined);

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('CREDENTIAL_EXPIRED');
  });

  it('returns REFUND_FAILED when createInvoice fails', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockRejectedValue(
      new PaymentError('LND connection error', 'PAYMENT_FAILED'),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('PAYMENT_FAILED');
  });

  it('maps 410 backend error to REFUND_WINDOW_EXPIRED', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
      new AskAHumanError('Refund window expired', 'API_ERROR', 410),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('REFUND_WINDOW_EXPIRED');
  });

  it('maps 400/409 backend error to NOT_ELIGIBLE', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
      new AskAHumanError('Already refunded', 'API_ERROR', 409),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('NOT_ELIGIBLE');
  });

  it('does not delete credential on refund failure', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
      new AskAHumanError('server error', 'API_ERROR', 500),
    );

    await handler({ verificationId: 'vid-123' });
    expect(mocks.credentialStore.delete).not.toHaveBeenCalled();
  });

  it('returns REFUND_FAILED when totalInvoiceSats is missing', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      // No totalInvoiceSats
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('totalInvoiceSats');
  });

  it('maps generic error from requestRefund as PAYMENT_FAILED', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
      new Error('unexpected failure'),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('PAYMENT_FAILED');
    expect(parsed.failureReason).toContain('unexpected failure');
  });

  it('handles non-Error thrown object in requestRefund', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockRejectedValue('string error');

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('string error');
  });

  it('handles refundResult.refunded being false', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({
      bolt11: 'lnbc50n1refund...', rHash: 'hash',
    });

    (mocks.client.requestRefund as jest.Mock).mockResolvedValue({ refunded: false });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('rejected');
  });

  it('handles non-PaymentError from createInvoice', async () => {
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    });

    (mocks.credentialStore.get as jest.Mock).mockReturnValue('preimage');

    (mocks.lightning.createInvoice as jest.Mock).mockRejectedValue(
      new Error('generic error'),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('generic error');
  });

  it('returns REFUND_FAILED when status lookup fails', async () => {
    (mocks.client.getVerification as jest.Mock).mockRejectedValue(
      new AskAHumanError('network error', 'NETWORK_ERROR'),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('REFUND_FAILED');
    expect(parsed.failureReason).toContain('network error');
  });

  describe('refund invoice lifecycle', () => {
    const EXPIRED = {
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      totalInvoiceSats: 50,
    };

    /** Back the mocked store's invoice accessors with real state so retries behave like production. */
    function statefulInvoiceStore(): void {
      let stored: string | undefined;
      (mocks.credentialStore.getRefundInvoice as jest.Mock).mockImplementation(() => stored);
      (mocks.credentialStore.setRefundInvoice as jest.Mock).mockImplementation((_id: string, b: string) => {
        stored = b;
      });
    }

    beforeEach(() => {
      (mocks.client.getVerification as jest.Mock).mockResolvedValue(EXPIRED);
      (mocks.credentialStore.get as jest.Mock).mockReturnValue('stored-preimage');
    });

    it('first attempt creates the invoice with an 8-day expiry and stores it', async () => {
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockResolvedValue({ refunded: true });

      await handler({ verificationId: 'vid-123' });

      expect(mocks.lightning.createInvoice).toHaveBeenCalledWith(50, 'AskAHuman refund', 691200);
      expect(mocks.credentialStore.setRefundInvoice).toHaveBeenCalledWith('vid-123', 'lnbc50n1first');
      expect(mocks.client.requestRefund).toHaveBeenCalledWith('vid-123', 'lnbc50n1first', 'stored-preimage');
    });

    it('passes the stored proof when checking status', async () => {
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockResolvedValue({ refunded: true });

      await handler({ verificationId: 'vid-123' });

      expect(mocks.client.getVerification).toHaveBeenCalledWith('vid-123', { macaroon: 'mac', preimage: 'pre' });
    });

    it('retry after a 5xx reuses the identical invoice and does not call createInvoice again', async () => {
      statefulInvoiceStore();
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock)
        .mockRejectedValueOnce(new AskAHumanError('server error', 'API_ERROR', 503))
        .mockResolvedValueOnce({ refunded: true });

      const first = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;
      expect(first.status).toBe('REFUND_FAILED');
      // Invoice survives the failed attempt; credential is not deleted
      expect(mocks.credentialStore.delete).not.toHaveBeenCalled();
      expect(mocks.credentialStore.getRefundInvoice('vid-123')).toBe('lnbc50n1first');

      const second = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;
      expect(second.status).toBe('REFUNDED');

      expect(mocks.lightning.createInvoice).toHaveBeenCalledTimes(1);
      const calls = (mocks.client.requestRefund as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toBe('lnbc50n1first');
      expect(calls[1][1]).toBe('lnbc50n1first');
      expect(mocks.credentialStore.delete).not.toHaveBeenCalled();
    });

    it('does not store an invoice when createInvoice fails', async () => {
      (mocks.lightning.createInvoice as jest.Mock).mockRejectedValue(new Error('lnd down'));

      await handler({ verificationId: 'vid-123' });

      expect(mocks.credentialStore.setRefundInvoice).not.toHaveBeenCalled();
      expect(mocks.client.requestRefund).not.toHaveBeenCalled();
    });

    it('maps 409 REFUND_INVOICE_MISMATCH body to its own failure reason', async () => {
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
        new AskAHumanError('conflict', 'API_ERROR', 409, JSON.stringify({ error: 'REFUND_INVOICE_MISMATCH' })),
      );

      const parsed = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;

      expect(parsed.status).toBe('REFUND_FAILED');
      expect(parsed.failureReason).toMatch(/^REFUND_INVOICE_MISMATCH:/);
    });

    it.each([
      ['plain 409 without a body', 409, undefined],
      ['409 with a non-JSON body', 409, 'not json'],
      ['409 with a different error code', 409, JSON.stringify({ error: 'ALREADY_REFUNDED' })],
      ['400 carrying the mismatch code', 400, JSON.stringify({ error: 'REFUND_INVOICE_MISMATCH' })],
    ])('maps %s to NOT_ELIGIBLE', async (_label, status, body) => {
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockRejectedValue(
        new AskAHumanError('conflict', 'API_ERROR', status, body),
      );

      const parsed = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;

      expect(parsed.failureReason).toMatch(/^NOT_ELIGIBLE:/);
    });

    it('REFUND_PENDING returns REFUND_IN_PROGRESS without creating an invoice or refunding', async () => {
      (mocks.client.getVerification as jest.Mock).mockResolvedValue({
        ...EXPIRED,
        status: VerificationStatus.REFUND_PENDING,
      });

      const parsed = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;

      expect(parsed.status).toBe('REFUND_FAILED');
      expect(parsed.failureReason).toMatch(/^REFUND_IN_PROGRESS:/);
      expect(mocks.lightning.createInvoice).not.toHaveBeenCalled();
      expect(mocks.client.requestRefund).not.toHaveBeenCalled();
    });

    it('rejects an overlapping call for the same verification without touching client or lightning', async () => {
      let releaseRefund!: (v: { refunded: boolean }) => void;
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockReturnValue(
        new Promise((resolve) => { releaseRefund = resolve; }),
      );

      const firstCall = handler({ verificationId: 'vid-123' });
      // Let the first call advance until it is blocked on requestRefund
      await new Promise((resolve) => setImmediate(resolve));
      expect(mocks.client.requestRefund).toHaveBeenCalledTimes(1);

      const second = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;
      expect(second.status).toBe('REFUND_FAILED');
      expect(second.failureReason).toMatch(/^REFUND_IN_PROGRESS:/);
      expect(mocks.client.getVerification).toHaveBeenCalledTimes(1);
      expect(mocks.lightning.createInvoice).toHaveBeenCalledTimes(1);
      expect(mocks.client.requestRefund).toHaveBeenCalledTimes(1);

      releaseRefund({ refunded: true });
      const first = parseToolResult(await firstCall) as Record<string, unknown>;
      expect(first.status).toBe('REFUNDED');
    });

    it('releases the lock after a call finishes so a later call proceeds', async () => {
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      (mocks.client.requestRefund as jest.Mock).mockResolvedValueOnce({ refunded: true });

      await handler({ verificationId: 'vid-123' });
      const parsed = parseToolResult(await handler({ verificationId: 'vid-123' })) as Record<string, unknown>;

      expect(parsed.status).toBe('REFUNDED');
    });

    it('does not block overlapping calls for different verifications', async () => {
      let release!: (v: { refunded: boolean }) => void;
      (mocks.lightning.createInvoice as jest.Mock).mockResolvedValue({ bolt11: 'lnbc50n1first', rHash: 'h' });
      (mocks.client.requestRefund as jest.Mock)
        .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
        .mockResolvedValueOnce({ refunded: true });

      const a = handler({ verificationId: 'vid-a' });
      await new Promise((resolve) => setImmediate(resolve));
      const b = parseToolResult(await handler({ verificationId: 'vid-b' })) as Record<string, unknown>;
      expect(b.status).toBe('REFUNDED');

      release({ refunded: true });
      await a;
    });
  });
});
