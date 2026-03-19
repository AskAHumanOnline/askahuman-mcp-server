/**
 * cancel_verification tool: advisory only, no state change.
 * Checks the current status and provides guidance on next steps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAHumanClient } from "../services/askahuman-client.js";
import { VerificationStatus } from "../types.js";

export function registerCancelVerification(
  server: McpServer,
  client: AskAHumanClient,
): void {
  server.tool(
    "cancel_verification",
    "Stop waiting for a verification and check refund eligibility. Does not cancel the payment or change any state. Returns guidance on whether to wait or request a refund.",
    {
      verificationId: z.string().uuid().describe("The verification request ID"),
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

      let nextStep: string;
      let message: string;

      switch (v.status) {
        case VerificationStatus.IN_QUEUE:
          nextStep = "wait_for_expiry";
          message = v.queueExpiresAt
            ? `Task is in the queue awaiting a verifier. Wait until ${v.queueExpiresAt} then call request_refund to reclaim your sats.`
            : "Task is in the queue awaiting a verifier. It will expire after the maxWaitMinutes window elapses, then call request_refund.";
          break;
        case VerificationStatus.ASSIGNED:
          nextStep = "wait_for_expiry";
          message = "A verifier has claimed this task and is actively working on it. Call check_verification to catch the result, or wait until the queue expiry for a refund if it is abandoned.";
          break;
        case VerificationStatus.EXPIRED_UNCLAIMED:
          nextStep = "call_request_refund";
          message = "Task has expired unclaimed. Call request_refund to reclaim your sats.";
          break;
        case VerificationStatus.COMPLETED:
          nextStep = "already_completed";
          message = "Task was completed and a result is available. No refund is applicable.";
          break;
        case VerificationStatus.REFUNDED:
          nextStep = "already_refunded";
          message = "Task was already refunded.";
          break;
        case VerificationStatus.EXPIRED:
          nextStep = "no_refund_needed";
          message = "Invoice was never paid -- no refund needed.";
          break;
        default:
          nextStep = "wait_for_expiry";
          message = `Task is in status ${v.status}. Continue polling with check_verification.`;
      }

      const result: Record<string, unknown> = {
        status: v.status,
        message,
        nextStep,
        refundEligible: v.refundEligible ?? false,
      };
      if (v.queueExpiresAt) result.queueExpiresAt = v.queueExpiresAt;
      if (v.refundDeadline) result.refundDeadline = v.refundDeadline;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
}
