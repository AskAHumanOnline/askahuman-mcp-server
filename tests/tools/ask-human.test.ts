/**
 * Unit tests for the ask_human tool.
 *
 * ask_human is fire-and-return: it prices, pays via L402, submits the request,
 * then returns immediately with status PENDING and a verificationId. Polling for
 * the human's answer is the job of the separate check_verification tool, so the
 * status-mapping / refund cases live in check-verification.test.ts, not here.
 */

import { registerAskHuman } from '../../src/tools/ask-human.js';
import { L402Credentials, L402Service } from '../../src/services/l402-service.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import type { CredentialStore } from '../../src/services/credential-store.js';
import type { Config } from '../../src/config.js';
import { VerificationStatus } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

const TEST_CONFIG: Config = {
  askahumanApiUrl: 'https://api.example.com',
  lndRestUrl: 'https://localhost:8080',
  lndMacaroonHex: 'deadbeef',
  logLevel: 'info',
  agentId: 'test-agent',
};

function createMocks() {
  const l402Service = {
    authenticate: jest.fn(),
  } as unknown as jest.Mocked<L402Service>;

  const client = {
    submitVerificationWithL402: jest.fn(),
    getVerification: jest.fn(),
    getPricing: jest.fn(),
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

/** Wire up authenticate + submit so the handler reaches its PENDING return. */
function mockPaidSubmission(mocks: ReturnType<typeof createMocks>, preimage = 'preimage-hex') {
  const creds = new L402Credentials('mac', preimage, 'vid-123');
  (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
  (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
    verificationId: 'vid-123',
    status: VerificationStatus.PAYMENT_RECEIVED,
    createdAt: '2026-01-01T00:00:00Z',
  });
}

describe('ask_human tool', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: ToolHandler;

  beforeEach(() => {
    mocks = createMocks();
    (mocks.client.getPricing as jest.Mock).mockResolvedValue({
      taskTypes: [
        {
          id: 'BINARY_DECISION',
          displayName: 'Binary Decision',
          description: 'Yes/no question',
          basePriceSats: 50,
          urgentPriceSats: 100,
          tierPricing: {},
        },
      ],
      urgentMultiplier: 2.0,
    });
    handler = setupTool(mocks);
  });

  it('happy path: prices -> pays -> submits -> returns PENDING', async () => {
    mockPaidSubmission(mocks);

    const result = await handler(BASE_ARGS);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('PENDING');
    expect(parsed.verificationId).toBe('vid-123');
    expect(parsed.taskType).toBe('BINARY_DECISION');
    expect(parsed.amountPaidSats).toBe(50);

    // Credential (preimage) cached for later check_verification / refund
    expect(mocks.credentialStore.set).toHaveBeenCalledWith('vid-123', 'preimage-hex');
  });

  it('returns UNKNOWN_TASK_TYPE when the server does not price the task type', async () => {
    (mocks.client.getPricing as jest.Mock).mockResolvedValue({
      taskTypes: [],
      urgentMultiplier: 2.0,
    });

    const result = await handler(BASE_ARGS);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('UNKNOWN_TASK_TYPE');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });

  it('returns BUDGET_EXCEEDED when maxBudgetSats is below the server price', async () => {
    const result = await handler({ ...BASE_ARGS, maxBudgetSats: 10 });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('BUDGET_EXCEEDED');
    expect(parsed.message).toContain('50');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });

  it('uses maxBudgetSats as the offer when above the server price', async () => {
    mockPaidSubmission(mocks);

    const result = await handler({ ...BASE_ARGS, maxBudgetSats: 120 });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.amountPaidSats).toBe(120);
    const authCall = (mocks.l402Service.authenticate as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(authCall.amountSats).toBe(120);
    expect(authCall.maxBudgetSats).toBe(120);
  });

  it('charges the urgent price when urgent is set', async () => {
    mockPaidSubmission(mocks);

    const result = await handler({ ...BASE_ARGS, urgent: true });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.amountPaidSats).toBe(100);
  });

  it('returns PRICING_FAILED when pricing lookup throws', async () => {
    (mocks.client.getPricing as jest.Mock).mockRejectedValue(new Error('pricing down'));

    const result = await handler(BASE_ARGS);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('PRICING_FAILED');
    expect(parsed.message).toContain('pricing down');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
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

  it('includes optional fields in the request when provided', async () => {
    mockPaidSubmission(mocks);

    const result = await handler({
      ...BASE_ARGS, // BINARY_DECISION (priced in beforeEach)
      context: 'some context',
      choices: ['a', 'b'],
      callbackUrl: 'https://example.com/cb',
      maxBudgetSats: 100,
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe('PENDING');

    // The request was built with the optional fields wired through
    const authCall = (mocks.l402Service.authenticate as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(authCall.maxBudgetSats).toBe(100);
    expect(authCall.callbackUrl).toBe('https://example.com/cb');
    expect((authCall.taskData as Record<string, unknown>).context).toBe('some context');
    expect((authCall.taskData as Record<string, unknown>).choices).toEqual(['a', 'b']);
  });

  it('accepts MEDIA_VERIFICATION with images[] and wires them into the request body', async () => {
    (mocks.client.getPricing as jest.Mock).mockResolvedValue({
      taskTypes: [
        {
          id: 'MEDIA_VERIFICATION',
          displayName: 'Media Verification',
          description: 'Verify images, free-form answer',
          basePriceSats: 80,
          urgentPriceSats: 160,
          tierPricing: {},
        },
      ],
      urgentMultiplier: 2.0,
    });

    const creds = new L402Credentials('mac', 'pre', 'vid-media');
    (mocks.l402Service.authenticate as jest.Mock).mockResolvedValue(creds);
    (mocks.client.submitVerificationWithL402 as jest.Mock).mockResolvedValue({
      verificationId: 'vid-media',
      status: VerificationStatus.PAYMENT_RECEIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const images = ['https://example.com/a.jpg', 'https://example.com/b.png'];
    const result = await handler({
      question: 'What is in these images?',
      taskType: 'MEDIA_VERIFICATION',
      urgent: false,
      maxWaitMinutes: 240,
      images,
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe('PENDING');
    expect(parsed.verificationId).toBe('vid-media');
    expect(parsed.taskType).toBe('MEDIA_VERIFICATION');

    // Images flow into taskData, mirroring how choices are wired
    const authCall = (mocks.l402Service.authenticate as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(authCall.taskType).toBe('MEDIA_VERIFICATION');
    expect((authCall.taskData as Record<string, unknown>).images).toEqual(images);
  });

  it('rejects MEDIA_VERIFICATION without images', async () => {
    const result = await handler({
      question: 'What is in the image?',
      taskType: 'MEDIA_VERIFICATION',
      urgent: false,
      maxWaitMinutes: 240,
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('VALIDATION_ERROR');
    // Validation runs before any pricing/payment work
    expect(mocks.client.getPricing).not.toHaveBeenCalled();
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });

  it('rejects http:// image URLs (https only)', async () => {
    const result = await handler({
      question: 'What is in the image?',
      taskType: 'MEDIA_VERIFICATION',
      urgent: false,
      maxWaitMinutes: 240,
      images: ['http://example.com/insecure.jpg'],
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('VALIDATION_ERROR');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });

  it('rejects images[] supplied for a non-MEDIA task type', async () => {
    const result = await handler({
      ...BASE_ARGS, // BINARY_DECISION
      images: ['https://example.com/a.jpg'],
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('VALIDATION_ERROR');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });

  it('rejects choices[] supplied together with MEDIA_VERIFICATION', async () => {
    const result = await handler({
      question: 'What is in the image?',
      taskType: 'MEDIA_VERIFICATION',
      urgent: false,
      maxWaitMinutes: 240,
      images: ['https://example.com/a.jpg'],
      choices: ['cat', 'dog'],
    });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('VALIDATION_ERROR');
    expect(mocks.l402Service.authenticate).not.toHaveBeenCalled();
  });
});
