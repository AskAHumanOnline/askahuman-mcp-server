/**
 * Unit tests for AskAHumanClient.
 * All HTTP calls are mocked via global fetch.
 */

import { AskAHumanClient, AskAHumanError } from '../../src/services/askahuman-client.js';
import type { Config } from '../../src/config.js';
import { TaskType } from '../../src/types.js';

const TEST_CONFIG: Config = {
  askahumanApiUrl: 'https://api.example.com',
  lndRestUrl: 'https://localhost:8080',
  lndMacaroonHex: 'deadbeef',
  logLevel: 'info',
};

function mockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let client: AskAHumanClient;

beforeEach(() => {
  client = new AskAHumanClient(TEST_CONFIG);
  jest.restoreAllMocks();
});

describe('AskAHumanClient', () => {
  describe('createVerificationRequest', () => {
    const req = {
      agentId: 'test',
      taskType: TaskType.BINARY_DECISION,
      taskData: { question: 'Is this spam?' },
    };

    it('parses colon-separated WWW-Authenticate header', async () => {
      const macaroon = 'abc123macaroon';
      const invoice = 'lnbc100n1invoice';
      const verificationId = '550e8400-e29b-41d4-a716-446655440000';

      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId, totalInvoiceSats: 50 },
          { 'WWW-Authenticate': `L402 ${macaroon}:${invoice}` },
        ),
      );

      const challenge = await client.createVerificationRequest(req);
      expect(challenge.macaroon).toBe(macaroon);
      expect(challenge.invoice).toBe(invoice);
      expect(challenge.verificationId).toBe(verificationId);
      expect(challenge.amountSats).toBe(50);
    });

    it('parses named-parameter WWW-Authenticate header', async () => {
      const macaroon = 'abc123macaroon';
      const invoice = 'lnbc100n1invoice';
      const verificationId = '550e8400-e29b-41d4-a716-446655440000';

      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId, amountSats: 25 },
          { 'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${invoice}"` },
        ),
      );

      const challenge = await client.createVerificationRequest(req);
      expect(challenge.macaroon).toBe(macaroon);
      expect(challenge.invoice).toBe(invoice);
      expect(challenge.amountSats).toBe(25);
    });

    it('prefers totalInvoiceSats over amountSats', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId: '550e8400-e29b-41d4-a716-446655440000', totalInvoiceSats: 100, amountSats: 50 },
          { 'WWW-Authenticate': 'L402 mac:inv' },
        ),
      );

      const challenge = await client.createVerificationRequest(req);
      expect(challenge.amountSats).toBe(100);
    });

    it('throws PAYMENT_REQUIRED_UNEXPECTED for non-402 status', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(200, { verificationId: 'abc' }),
      );

      await expect(client.createVerificationRequest(req)).rejects.toThrow(AskAHumanError);
      await expect(client.createVerificationRequest(req)).rejects.toMatchObject({
        code: 'PAYMENT_REQUIRED_UNEXPECTED',
      });
    });

    it('throws API_ERROR when WWW-Authenticate header is missing', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId: '550e8400-e29b-41d4-a716-446655440000', amountSats: 25 },
          {},
        ),
      );

      await expect(client.createVerificationRequest(req)).rejects.toThrow(AskAHumanError);
      await expect(client.createVerificationRequest(req)).rejects.toMatchObject({
        code: 'API_ERROR',
      });
    });

    it('throws API_ERROR when verificationId is missing', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { amountSats: 25 },
          { 'WWW-Authenticate': 'L402 mac:inv' },
        ),
      );

      await expect(client.createVerificationRequest(req)).rejects.toThrow(AskAHumanError);
    });

    it('throws API_ERROR for invalid verificationId format', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId: 'not-a-uuid', amountSats: 25 },
          { 'WWW-Authenticate': 'L402 mac:inv' },
        ),
      );

      await expect(client.createVerificationRequest(req)).rejects.toMatchObject({
        code: 'API_ERROR',
        message: expect.stringContaining('invalid verificationId'),
      });
    });

    it('throws API_ERROR for invalid amountSats', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId: '550e8400-e29b-41d4-a716-446655440000', amountSats: -10 },
          { 'WWW-Authenticate': 'L402 mac:inv' },
        ),
      );

      await expect(client.createVerificationRequest(req)).rejects.toMatchObject({
        code: 'API_ERROR',
        message: expect.stringContaining('invalid amountSats'),
      });
    });

    it('throws API_ERROR for credential exceeding max length', async () => {
      const longMac = 'a'.repeat(9000);
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(
          402,
          { verificationId: '550e8400-e29b-41d4-a716-446655440000', amountSats: 25 },
          { 'WWW-Authenticate': `L402 ${longMac}:inv` },
        ),
      );

      await expect(client.createVerificationRequest(req)).rejects.toMatchObject({
        code: 'API_ERROR',
        message: expect.stringContaining('maximum length'),
      });
    });
  });

  describe('submitVerificationWithL402', () => {
    const req = {
      agentId: 'test',
      taskType: TaskType.BINARY_DECISION,
      taskData: { question: 'Is this spam?' },
    };

    it('sends correct Authorization header format', async () => {
      const macaroon = 'my-macaroon';
      const preimage = 'deadbeef1234';

      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const opts = init as RequestInit;
        expect((opts.headers as Record<string, string>).Authorization).toBe(
          `L402 ${macaroon}:${preimage}`,
        );
        return mockResponse(202, {
          verificationId: '550e8400-e29b-41d4-a716-446655440000',
          status: 'PAYMENT_RECEIVED',
          createdAt: '2026-01-01T00:00:00Z',
        });
      });

      const result = await client.submitVerificationWithL402(req, macaroon, preimage);
      expect(result.status).toBe('PAYMENT_RECEIVED');
    });

    it('throws PAYMENT_REQUIRED_UNEXPECTED on 402 response', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(402, { error: 'payment not recognized' }),
      );

      await expect(
        client.submitVerificationWithL402(req, 'mac', 'pre'),
      ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED_UNEXPECTED' });
    });

    it('throws API_ERROR on 500 response', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(500, { error: 'internal server error' }),
      );

      await expect(
        client.submitVerificationWithL402(req, 'mac', 'pre'),
      ).rejects.toMatchObject({ code: 'API_ERROR', status: 500 });
    });
  });

  describe('getVerification', () => {
    it('returns parsed verification response', async () => {
      const responseBody = {
        verificationId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'COMPLETED',
        result: { answer: 'yes', confidence: 0.95 },
        createdAt: '2026-01-01T00:00:00Z',
      };

      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(200, responseBody),
      );

      const result = await client.getVerification('550e8400-e29b-41d4-a716-446655440000');
      expect(result.status).toBe('COMPLETED');
      expect(result.result?.answer).toBe('yes');
    });

    it('throws API_ERROR on non-2xx response', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(404, { error: 'not found' }),
      );

      await expect(
        client.getVerification('550e8400-e29b-41d4-a716-446655440000'),
      ).rejects.toMatchObject({ code: 'API_ERROR', status: 404 });
    });
  });

  describe('requestRefund', () => {
    it('sends both invoice and preimage in body', async () => {
      const bolt11 = 'lnbc100n1...';
      const preimage = 'abc123hex';
      const vId = '550e8400-e29b-41d4-a716-446655440000';

      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const opts = init as RequestInit;
        const body = JSON.parse(opts.body as string) as { invoice: string; preimage: string };
        expect(body.invoice).toBe(bolt11);
        expect(body.preimage).toBe(preimage);
        return mockResponse(200, { refunded: true });
      });

      const result = await client.requestRefund(vId, bolt11, preimage);
      expect(result.refunded).toBe(true);
    });

    it('throws API_ERROR on non-2xx refund response', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(410, { error: 'refund window expired' }),
      );

      await expect(
        client.requestRefund('id', 'inv', 'pre'),
      ).rejects.toMatchObject({ code: 'API_ERROR', status: 410 });
    });
  });

  describe('getPricing', () => {
    it('returns mapped PricingResponse', async () => {
      const pricingBody = {
        taskTypes: [
          { id: 'BINARY_DECISION', displayName: 'Binary', description: 'Yes/No', basePriceSats: 25, urgentPriceSats: 50, tierPricing: {} },
        ],
        urgentMultiplier: 2.0,
      };

      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(200, pricingBody),
      );

      const result = await client.getPricing();
      expect(result.taskTypes).toHaveLength(1);
      expect(result.taskTypes[0].id).toBe('BINARY_DECISION');
      expect(result.urgentMultiplier).toBe(2.0);
    });

    it('throws API_ERROR on non-2xx response', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockResponse(503, 'Service unavailable'),
      );

      await expect(client.getPricing()).rejects.toMatchObject({ code: 'API_ERROR', status: 503 });
    });
  });

  describe('network errors', () => {
    it('wraps fetch network errors as NETWORK_ERROR', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.getVerification('id')).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });

    it('wraps timeout DOMException as NETWORK_ERROR', async () => {
      const err = new DOMException('The operation was aborted', 'TimeoutError');
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(err);

      await expect(client.getVerification('id')).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: 'Request timed out',
      });
    });
  });

  describe('AskAHumanError', () => {
    it('has non-enumerable _body property', () => {
      const err = new AskAHumanError('test', 'API_ERROR', 500, 'secret body');
      expect(err.body).toBe('secret body');
      const serialized = JSON.stringify(err);
      expect(serialized).not.toContain('secret body');
    });
  });
});
