/**
 * Shared test helpers for tool tests.
 * Captures the tool handler when a tool registers itself on a mock McpServer.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The tool handler signature: receives parsed args and returns MCP tool result
export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

/**
 * Create a mock McpServer that captures the first tool handler registered.
 * Returns both the mock server and a getter for the captured handler.
 */
export function createMockServer(): {
  server: McpServer;
  getHandler: () => ToolHandler;
} {
  let capturedHandler: ToolHandler | null = null;

  const server = {
    tool: jest.fn((...args: unknown[]) => {
      // server.tool(name, description, schema, handler) -- handler is last arg
      capturedHandler = args[args.length - 1] as ToolHandler;
    }),
  } as unknown as McpServer;

  return {
    server,
    getHandler: () => {
      if (!capturedHandler) throw new Error('No tool handler was registered');
      return capturedHandler;
    },
  };
}

/** Parse the JSON text from an MCP tool result. */
export function parseToolResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}
