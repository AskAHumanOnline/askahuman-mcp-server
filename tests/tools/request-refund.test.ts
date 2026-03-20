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

  it('happy path: confirms EXPIRED_UNCLAIMED, creates invoice, submits refund, deletes credential', async () => {
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

    // Verify credential was deleted after success
    expect(mocks.credentialStore.delete).toHaveBeenCalledWith('vid-123');
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
});
