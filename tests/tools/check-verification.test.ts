/**
 * Unit tests for the check_verification tool.
 */

import { registerCheckVerification } from '../../src/tools/check-verification.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import { AskAHumanError } from '../../src/services/askahuman-client.js';
import { VerificationStatus } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

function createMockClient(): jest.Mocked<Pick<AskAHumanClient, 'getVerification'>> {
  return { getVerification: jest.fn() };
}

function setupTool(client: ReturnType<typeof createMockClient>): ToolHandler {
  const { server, getHandler } = createMockServer();
  registerCheckVerification(server, client as unknown as AskAHumanClient);
  return getHandler();
}

describe('check_verification tool', () => {
  let client: ReturnType<typeof createMockClient>;
  let handler: ToolHandler;

  beforeEach(() => {
    client = createMockClient();
    handler = setupTool(client);
  });

  it('maps all status fields including optional fields', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T01:00:00Z',
      queueExpiresAt: '2026-01-01T04:00:00Z',
      refundEligible: true,
      refundDeadline: '2026-01-08T00:00:00Z',
      totalInvoiceSats: 50,
      amountSats: 25,
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('EXPIRED_UNCLAIMED');
    expect(parsed.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(parsed.expiresAt).toBe('2026-01-01T01:00:00Z');
    expect(parsed.queueExpiresAt).toBe('2026-01-01T04:00:00Z');
    expect(parsed.refundEligible).toBe(true);
    expect(parsed.refundDeadline).toBe('2026-01-08T00:00:00Z');
    expect(parsed.totalInvoiceSats).toBe(50);
    expect(parsed.amountSats).toBe(25);
  });

  it('includes result when status is COMPLETED', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      createdAt: '2026-01-01T00:00:00Z',
      result: { answer: 'yes', confidence: 0.9 },
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('COMPLETED');
    expect(parsed.result).toEqual({ answer: 'yes', confidence: 0.9 });
    expect(parsed.terminal).toBe(true);
    expect(parsed.nextStep).toBe('done');
  });

  it('signals keep_polling for non-terminal statuses', async () => {
    for (const status of [
      VerificationStatus.PENDING_PAYMENT,
      VerificationStatus.PAYMENT_RECEIVED,
      VerificationStatus.IN_QUEUE,
      VerificationStatus.ASSIGNED,
      VerificationStatus.ESCALATED,
    ]) {
      client.getVerification.mockResolvedValue({
        verificationId: 'vid-123',
        status,
        createdAt: '2026-01-01T00:00:00Z',
      });

      const result = await handler({ verificationId: 'vid-123' });
      const parsed = parseToolResult(result) as Record<string, unknown>;

      expect(parsed.status).toBe(status);
      expect(parsed.terminal).toBe(false);
      expect(parsed.nextStep).toBe('keep_polling');
    }
  });

  it('directs to request_refund and stops polling when EXPIRED_UNCLAIMED', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.terminal).toBe(true);
    expect(parsed.nextStep).toBe('call_request_refund');
    expect(parsed.refundEligible).toBe(true);
  });

  it.each([
    [VerificationStatus.CANCELLED, 'cancelled'],
    [VerificationStatus.EXPIRED, 'expired_unpaid'],
    [VerificationStatus.REFUNDED, 'already_refunded'],
  ])('marks %s terminal so the agent stops polling', async (status, nextStep) => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.terminal).toBe(true);
    expect(parsed.nextStep).toBe(nextStep);
  });

  it('omits optional fields when not present', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.IN_QUEUE,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('IN_QUEUE');
    expect(parsed).not.toHaveProperty('result');
    expect(parsed).not.toHaveProperty('refundEligible');
    expect(parsed).not.toHaveProperty('queueExpiresAt');
  });

  it('returns LOOKUP_FAILED on API error', async () => {
    client.getVerification.mockRejectedValue(
      new AskAHumanError('Not found', 'API_ERROR', 404),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('LOOKUP_FAILED');
    expect(parsed.message).toContain('Not found');
  });

  it('returns LOOKUP_FAILED with string representation for non-Error objects', async () => {
    client.getVerification.mockRejectedValue('string error');

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('LOOKUP_FAILED');
    expect(parsed.message).toContain('string error');
  });
});
