/**
 * Unit tests for the get_pricing tool.
 */

import { registerGetPricing } from '../../src/tools/get-pricing.js';
import type { AskAHumanClient } from '../../src/services/askahuman-client.js';
import { AskAHumanError } from '../../src/services/askahuman-client.js';
import type { PricingResponse } from '../../src/types.js';
import { createMockServer, parseToolResult, type ToolHandler } from './test-helpers.js';

const SAMPLE_PRICING: PricingResponse = {
  taskTypes: [
    {
      id: 'BINARY_DECISION',
      displayName: 'Binary Decision',
      description: 'Yes/No question',
      basePriceSats: 25,
      urgentPriceSats: 50,
      tierPricing: {},
    },
    {
      id: 'MULTIPLE_CHOICE',
      displayName: 'Multiple Choice',
      description: 'Choose from options',
      basePriceSats: 35,
      urgentPriceSats: 70,
      tierPricing: {},
    },
    {
      id: 'TEXT_RESPONSE',
      displayName: 'Text Response',
      description: 'Free-form answer',
      basePriceSats: 50,
      urgentPriceSats: 100,
      tierPricing: {},
    },
  ],
  urgentMultiplier: 2.0,
};

function createMockClient(): jest.Mocked<Pick<AskAHumanClient, 'getPricing'>> {
  return { getPricing: jest.fn() };
}

function setupTool(client: ReturnType<typeof createMockClient>): ToolHandler {
  const { server, getHandler } = createMockServer();
  registerGetPricing(server, client as unknown as AskAHumanClient);
  return getHandler();
}

describe('get_pricing tool', () => {
  let client: ReturnType<typeof createMockClient>;
  let handler: ToolHandler;

  beforeEach(() => {
    client = createMockClient();
    handler = setupTool(client);
  });

  it('returns all task types when no filter', async () => {
    client.getPricing.mockResolvedValue(SAMPLE_PRICING);

    const result = await handler({});
    const parsed = parseToolResult(result) as Record<string, unknown>;

    const pricing = parsed.pricing as Array<{ id: string }>;
    expect(pricing).toHaveLength(3);
    expect(pricing.map((t) => t.id)).toEqual([
      'BINARY_DECISION',
      'MULTIPLE_CHOICE',
      'TEXT_RESPONSE',
    ]);
    expect(parsed.currency).toBe('sats');
    expect(parsed.urgentMultiplier).toBe(2.0);
  });

  it('filters to single task type when taskType provided', async () => {
    client.getPricing.mockResolvedValue(SAMPLE_PRICING);

    const result = await handler({ taskType: 'MULTIPLE_CHOICE' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    const pricing = parsed.pricing as Array<{ id: string }>;
    expect(pricing).toHaveLength(1);
    expect(pricing[0].id).toBe('MULTIPLE_CHOICE');
  });

  it('returns empty array when taskType does not match', async () => {
    client.getPricing.mockResolvedValue(SAMPLE_PRICING);

    const result = await handler({ taskType: 'NONEXISTENT' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.pricing).toEqual([]);
  });

  it('returns PRICING_UNAVAILABLE on API error', async () => {
    client.getPricing.mockRejectedValue(
      new AskAHumanError('Service unavailable', 'API_ERROR', 503),
    );

    const result = await handler({});
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('PRICING_UNAVAILABLE');
    expect(parsed.message).toContain('Service unavailable');
  });

  it('returns PRICING_UNAVAILABLE with string representation for non-Error objects', async () => {
    client.getPricing.mockRejectedValue('string error');

    const result = await handler({});
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.error).toBe('PRICING_UNAVAILABLE');
    expect(parsed.message).toContain('string error');
  });

  it('includes note about server-side pricing', async () => {
    client.getPricing.mockResolvedValue(SAMPLE_PRICING);

    const result = await handler({});
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.note).toContain('server-side');
  });
});
