/**
 * Unit tests for the ask_human tool.
 */

import { registerAskHuman } from '../../src/tools/ask-human.js';
import { L402Credentials, L402Service } from '../../src/services/l402-service.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import type { CredentialStore } from '../../src/services/credential-store.js';
import type { Config } from '../../src/config.js';
import { VerificationStatus } from '../../src/types.js';
import type { VerificationResponse } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

const TEST_CONFIG: Config = {
  askahumanApiUrl: 'https://api.example.com',
  lndRestUrl: 'https://localhost:8080',
  lndMacaroonHex: 'deadbeef',
  logLevel: 'info',
};

function createMocks() {
  const l402Service = {
    authenticate: jest.fn(),
  } as unknown as jest.Mocked<L402Service>;

  const client = {
    submitVerificationWithL402: jest.fn(),
    getVerification: jest.fn(),
  } as unknown as jest.Mocked<AskAHumanClient>;

  const credentialStore = {
    set: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<CredentialStore>;

  return { l402Service, client, credentialStore };
}

function setupTool(mocks: ReturnType<typeof createMocks>): ToolHandler {
  const { server, getHandler } = createMockServer();
  registerAskHuman(
    server,
    TEST_CONFIG,
    mocks.l402Service,
    mocks.client,
    mocks.credentialStore,
  );
  return getHandler();
}

const BASE_ARGS = {
  question: 'Is this spam?',
  taskType: 'BINARY_DECISION',
  urgent: false,
  maxWaitMinutes: 240,
};

describe('ask_human tool', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: ToolHandler;

  beforeEach(() => {
    jest.useFakeTimers();
    mocks = createMocks();
    handler = setupTool(mocks);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('happy path: authenticate -> submit -> poll -> COMPLETED', async () => {
    const creds = new L402Credentials('mac', 'preimage-hex', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    // First poll returns COMPLETED
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      result: { answer: 'yes', confidence: 0.95 },
      createdAt: '2026-01-01T00:00:00Z',
      totalInvoiceSats: 50,
    } satisfies VerificationResponse);

    // Run the handler and advance timers for sleep
    const resultPromise = handler(BASE_ARGS);
    // Advance past the first sleep (1s)
    await jest.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('COMPLETED');
    expect(parsed.verificationId).toBe('vid-123');
    expect(parsed.result).toEqual({ answer: 'yes', confidence: 0.95 });
    expect(parsed.invoiceAmountSats).toBe(50);

    // Verify credential was stored
    expect(mocks.credentialStore.set).toHaveBeenCalledWith('vid-123', 'preimage-hex');
  });

  it('returns EXPIRED_UNCLAIMED during poll without preimage in output', async () => {
    const creds = new L402Credentials('mac', 'secret-preimage', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED_UNCLAIMED,
      createdAt: '2026-01-01T00:00:00Z',
      refundEligible: true,
      refundDeadline: '2026-01-08T00:00:00Z',
    });

    const resultPromise = handler(BASE_ARGS);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('EXPIRED_UNCLAIMED');
    expect(parsed.refundEligible).toBe(true);
    expect(parsed.refundDeadline).toBe('2026-01-08T00:00:00Z');
    // Preimage must NOT appear in output
    const fullText = result.content[0].text;
    expect(fullText).not.toContain('secret-preimage');
  });

  it('returns TIMEOUT when max poll duration exceeded (task still IN_QUEUE)', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    // Always return IN_QUEUE
    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.IN_QUEUE,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const resultPromise = handler(BASE_ARGS);

    // Advance past the 10-minute default max poll time
    await jest.advanceTimersByTimeAsync(11 * 60 * 1000);

    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('TIMEOUT');
    expect(parsed.verificationId).toBe('vid-123');
    expect(parsed.status).toBe('IN_QUEUE');
  });

  it('returns PAYMENT_FAILED when authentication fails', async () => {
    (mocks.l402Service.authenticate as jest.Mock).mockRejectedValue(
      new Error('no route found'),
    );

    const result = await handler(BASE_ARGS);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('PAYMENT_FAILED');
    expect(parsed.message).toContain('no route found');
  });

  it('returns SUBMISSION_FAILED when L402 submission fails after payment', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockRejectedValue(
      new Error('server error'),
    );

    const result = await handler(BASE_ARGS);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('SUBMISSION_FAILED');
    expect(parsed.verificationId).toBe('vid-123');
    expect(parsed.message).toContain('server error');
  });

  it('returns EXPIRED for invoice-expired status during poll', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.EXPIRED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const resultPromise = handler(BASE_ARGS);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('EXPIRED');
  });

  it('returns ALREADY_REFUNDED for REFUNDED status during poll', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.REFUNDED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const resultPromise = handler(BASE_ARGS);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('ALREADY_REFUNDED');
  });

  it('continues polling on transient errors until timeout', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    // Always throw on getVerification (transient failure)
    (mocks.client.getVerification as jest.Mock).mockRejectedValue(
      new Error('network timeout'),
    );

    const resultPromise = handler(BASE_ARGS);
    // Advance past the 10-minute timeout
    await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('TIMEOUT');
    expect(parsed.message).toContain('network timeout');
  });

  it('includes optional fields in request when provided', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      result: { answer: 'yes' },
      createdAt: '2026-01-01T00:00:00Z',
      amountSats: 25,
    });

    const argsWithOptionals = {
      ...BASE_ARGS,
      context: 'some context',
      choices: ['a', 'b'],
      callbackUrl: 'https://example.com/cb',
      maxBudgetSats: 100,
    };

    const resultPromise = handler(argsWithOptionals);
    await jest.advanceTimersByTimeAsync(2000);
    await resultPromise;

    // Verify the request was built with optional fields
    const authCall = (mocks.l402Service.authenticate as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(authCall.maxBudgetSats).toBe(100);
    expect(authCall.callbackUrl).toBe('https://example.com/cb');
    expect((authCall.taskData as Record<string, unknown>).context).toBe('some context');
    expect((authCall.taskData as Record<string, unknown>).choices).toEqual(['a', 'b']);
  });

  it('falls back to amountSats when totalInvoiceSats is missing', async () => {
    const creds = new L402Credentials('mac', 'pre', 'vid-123');

    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    (mocks.client.getVerification as jest.Mock).mockResolvedValue({
      verificationId: 'vid-123',
      status: VerificationStatus.COMPLETED,
      result: { answer: 'no' },
      createdAt: '2026-01-01T00:00:00Z',
      amountSats: 30,
    });

    const resultPromise = handler(BASE_ARGS);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.invoiceAmountSats).toBe(30);
  });
});
