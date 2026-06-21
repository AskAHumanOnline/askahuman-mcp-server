/**
 * check_verification tool: check the status of a pending verification request.
 *
 * This is the primary result-retrieval mechanism after ask_human (which returns
 * immediately rather than blocking). It must therefore tell the agent when to
 * STOP polling: every status maps to a `terminal` flag and a `nextStep` so a
 * caller that loops "until COMPLETED" does not spin forever when the task
 * instead expires, is cancelled, or is refunded.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAHumanClient } from "../services/askahuman-client.js";
import { VerificationStatus } from "../types.js";

/** Guidance derived from a verification status: whether to keep polling and what to do next. */
interface StatusGuidance {
  terminal: boolean;
  nextStep: string;
  message: string;
}

/**
 * Map a verification status to polling guidance. Terminal statuses tell the agent
 * to stop polling; non-terminal statuses tell it to keep polling check_verification.
 */
function guidanceFor(status: VerificationStatus | string): StatusGuidance {
  switch (status) {
    case VerificationStatus.COMPLETED:
      return {
        terminal: true,
        nextStep: "done",
        message: "Verification complete. The human's answer is in the result field.",
      };
    case VerificationStatus.EXPIRED_UNCLAIMED:
      return {
        terminal: true,
        nextStep: "call_request_refund",
        message: "Task expired without being claimed by a verifier. Stop polling and call request_refund with this verificationId to reclaim your sats.",
      };
    case VerificationStatus.REFUNDED:
      return {
        terminal: true,
        nextStep: "already_refunded",
        message: "This verification was already refunded. Stop polling.",
      };
    case VerificationStatus.CANCELLED:
      return {
        terminal: true,
        nextStep: "cancelled",
        message: "This verification was cancelled. Stop polling.",
      };
    case VerificationStatus.EXPIRED:
      return {
        terminal: true,
        nextStep: "expired_unpaid",
        message: "The invoice expired before payment was confirmed; the task was never queued. Stop polling. No refund applies.",
      };
    default:
      // PENDING_PAYMENT, PAYMENT_RECEIVED, IN_QUEUE, ASSIGNED, ESCALATED, or any
      // future non-terminal status: the task is still live, keep polling.
      return {
        terminal: false,
        nextStep: "keep_polling",
        message: `Task is in status ${status}. Call check_verification again in 30-60 seconds.`,
      };
  }
}

export function registerCheckVerification(
  server: McpServer,
  client: AskAHumanClient,
): void {
  server.tool(
    "check_verification",
    "Check the status of a human verification request. Use this after ask_human to poll for the human's answer. Poll every 30-60 seconds while terminal is false. When terminal is true, STOP polling and follow nextStep: status COMPLETED puts the human's answer in the result field; EXPIRED_UNCLAIMED means you should call request_refund; CANCELLED/EXPIRED/REFUNDED mean the task is closed.",
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

      const guidance = guidanceFor(v.status);

      const result: Record<string, unknown> = {
        status: v.status,
        terminal: guidance.terminal,
        nextStep: guidance.nextStep,
        message: guidance.message,
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
