/**
 * Unit tests for the cancel_verification tool.
 */

import { registerCancelVerification } from '../../src/tools/cancel-verification.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import { AskAHumanError } from '../../src/services/askahuman-client.js';
import { VerificationStatus } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

function createMockClient(): jest.Mocked<Pick<AskAHumanClient, 'getVerification'>> {
  return { getVerification: jest.fn() };
}

function setupTool(client: ReturnType<typeof createMockClient>): ToolHandler {
  const { server, getHandler } = createMockServer();
  registerCancelVerification(server, client as unknown as AskAHumanClient);
  return getHandler();
}

describe('cancel_verification tool', () => {
  let client: ReturnType<typeof createMockClient>;
  let handler: ToolHandler;

  beforeEach(() => {
    client = createMockClient();
    handler = setupTool(client);
  });

  it('IN_QUEUE -> nextStep: wait_for_expiry', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.IN_QUEUE,
      createdAt: '2026-01-01T00:00:00Z',
      queueExpiresAt: '2026-01-01T04:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('wait_for_expiry');
    expect(parsed.status).toBe('IN_QUEUE');
    expect(parsed.message).toContain('queue');
    expect(parsed.queueExpiresAt).toBe('2026-01-01T04:00:00Z');
  });

  it('IN_QUEUE without queueExpiresAt uses fallback message', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.IN_QUEUE,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('wait_for_expiry');
    expect(parsed.message).toContain('maxWaitMinutes');
  });

  it('ASSIGNED -> nextStep: wait_for_expiry with different message', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.ASSIGNED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('wait_for_expiry');
    expect(parsed.message).toContain('claimed');
    expect(parsed.message).toContain('actively working');
  });

  it('EXPIRED_UNCLAIMED -> nextStep: call_request_refund', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      refundDeadline: '2026-01-08T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('call_request_refund');
    expect(parsed.message).toContain('request_refund');
    expect(parsed.refundDeadline).toBe('2026-01-08T00:00:00Z');
  });

  it('COMPLETED -> nextStep: already_completed', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      createdAt: '2026-01-01T00:00:00Z',
      result: { answer: 'yes' },
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('already_completed');
    expect(parsed.message).toContain('completed');
  });

  it('REFUNDED -> nextStep: already_refunded', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.REFUNDED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('already_refunded');
  });

  it('EXPIRED -> nextStep: no_refund_needed', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('no_refund_needed');
    expect(parsed.message).toContain('never paid');
  });

  it('default status -> nextStep: wait_for_expiry with status message', async () => {
    client.getVerification.mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.nextStep).toBe('wait_for_expiry');
    expect(parsed.message).toContain('PAYMENT_RECEIVED');
  });

  it('returns LOOKUP_FAILED on API error', async () => {
    client.getVerification.mockRejectedValue(
      new AskAHumanError('connection refused', 'NETWORK_ERROR'),
    );

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('LOOKUP_FAILED');
    expect(parsed.message).toContain('connection refused');
  });

  it('handles non-Error thrown objects', async () => {
    client.getVerification.mockRejectedValue('string error');

    const result = await handler({ verificationId: 'vid-123' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('LOOKUP_FAILED');
    expect(parsed.message).toContain('string error');
  });
});
