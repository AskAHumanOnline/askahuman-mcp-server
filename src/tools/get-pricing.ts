/**
 * get_pricing tool: check current server-side pricing for verification tasks.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAHumanClient } from "../services/askahuman-client.js";

export function registerGetPricing(
  server: McpServer,
  client: AskAHumanClient,
): void {
  server.tool(
    "get_pricing",
    "Check current server-side pricing for human verification tasks. Prices are set by the server and may change.",
    {
      taskType: z.enum(["BINARY_DECISION", "MULTIPLE_CHOICE", "TEXT_RESPONSE"]).optional().describe("Filter to a specific task type (optional)"),
    },
    async (args) => {
      let pricing;
      try {
        pricing = await client.getPricing();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "PRICING_UNAVAILABLE",
            message: `Could not retrieve pricing: ${message}`,
          }) }],
        };
      }

      const taskTypes = args.taskType
        ? pricing.taskTypes.filter((t) => t.id.toUpperCase() === args.taskType?.toUpperCase())
        : pricing.taskTypes;

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          pricing: taskTypes,
          currency: "sats",
          note: "Prices are set server-side and may change.",
          urgentMultiplier: pricing.urgentMultiplier,
        }) }],
      };
    },
  );
}
