#!/usr/bin/env node

/**
 * AskAHuman MCP Server entry point.
 * Provides human verification tools to MCP-compatible AI agents.
 *
 * Transport: stdio (standard for MCP servers spawned by hosts like Claude Desktop)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AskAHumanClient } from "./services/askahuman-client.js";
import { LightningService } from "./services/lightning-service.js";
import { L402Service } from "./services/l402-service.js";
import { registerAskHuman } from "./tools/ask-human.js";
import { registerCheckVerification } from "./tools/check-verification.js";
import { registerCancelVerification } from "./tools/cancel-verification.js";
import { registerRequestRefund } from "./tools/request-refund.js";
import { registerGetPricing } from "./tools/get-pricing.js";

async function main(): Promise<void> {
  const config = loadConfig(); // throws on missing env vars -- fail fast

  const askahumanClient = new AskAHumanClient(config);
  const lightningService = new LightningService(config);
  const l402Service = new L402Service(askahumanClient, lightningService);

  const server = new McpServer({
    name: "askahuman-mcp",
    version: "0.1.0",
  });

  registerAskHuman(server, config, l402Service, askahumanClient);
  registerCheckVerification(server, askahumanClient);
  registerCancelVerification(server, askahumanClient);
  registerRequestRefund(server, askahumanClient, lightningService);
  registerGetPricing(server, askahumanClient);

  // Register signal handlers before connecting so signals during connect are handled.
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
