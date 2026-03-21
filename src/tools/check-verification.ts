/**
 * check_verification tool: check the status of a pending verification request.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAHumanClient } from "../services/askahuman-client.js";

export function registerCheckVerification(
  server: McpServer,
  client: AskAHumanClient,
): void {
  server.tool(
    "check_verification",
    "Check the status of a human verification request. Use this after ask_human to poll for the human's answer. Poll every 30-60 seconds until status is COMPLETED, which includes the human's answer in the result field.",
    {
      verificationId: z.string().uuid().describe("The verification request ID to check"),
    },
    async (args) => {
      let v;
      try {
        v = await client.getVerification(args.verificationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "LOOKUP_FAILED",
            message: `Could not retrieve verification status: ${message}`,
          }) }],
        };
      }

      const result: Record<string, unknown> = {
        status: v.status,
        createdAt: v.createdAt,
      };
      if (v.result) result.result = v.result;
      if (v.expiresAt) result.expiresAt = v.expiresAt;
      if (v.queueExpiresAt) result.queueExpiresAt = v.queueExpiresAt;
      if (v.refundEligible !== undefined) result.refundEligible = v.refundEligible;
      if (v.refundDeadline) result.refundDeadline = v.refundDeadline;
      if (v.totalInvoiceSats !== undefined) result.totalInvoiceSats = v.totalInvoiceSats;
      if (v.amountSats !== undefined) result.amountSats = v.amountSats;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
}
