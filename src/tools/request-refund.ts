/**
 * request_refund tool: request a full refund for an expired-unclaimed verification.
 * Creates a Lightning invoice on the agent's LND node and submits it to the backend.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAHumanClient } from "../services/askahuman-client.js";
import { AskAHumanError } from "../services/askahuman-client.js";
import type { LightningService } from "../services/lightning-service.js";
import { PaymentError } from "../services/lightning-service.js";
import { VerificationStatus } from "../types.js";

export function registerRequestRefund(
  server: McpServer,
  client: AskAHumanClient,
  lightning: LightningService,
): void {
  server.tool(
    "request_refund",
    "Request a full refund for a paid verification task that expired without being claimed by a human verifier. Requires the original payment preimage as proof of payment.",
    {
      verificationId: z.string().uuid().describe("The ID of the expired verification request"),
      preimage: z.string().regex(/^[0-9a-f]{64}$/i).describe("Hex-encoded Lightning payment preimage from the original payment (64 hex chars = 32 bytes)"),
    },
    async (args) => {
      // Confirm refund eligibility by checking current status
      let v;
      try {
        v = await client.getVerification(args.verificationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason: `Could not check verification status: ${message}`,
          }) }],
        };
      }

      if (v.status !== VerificationStatus.EXPIRED_UNCLAIMED) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason: `NOT_ELIGIBLE: task status is ${v.status}, expected EXPIRED_UNCLAIMED`,
          }) }],
        };
      }

      if (v.refundEligible !== true) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason: "REFUND_WINDOW_EXPIRED: refund window has passed",
          }) }],
        };
      }

      // Determine refund amount — must use totalInvoiceSats (the full amount paid by the agent).
      // amountSats is the verifier payout, not the total invoice; using it would shortchange the refund.
      const refundAmountSats = v.totalInvoiceSats;
      if (!refundAmountSats || refundAmountSats <= 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason: "Could not determine refund amount: totalInvoiceSats missing from verification response",
          }) }],
        };
      }

      // Create a Lightning invoice on the agent's LND node to receive the refund
      let invoice;
      try {
        invoice = await lightning.createInvoice(refundAmountSats, "AskAHuman refund");
      } catch (error) {
        const reason = error instanceof PaymentError
          ? `LND error (${error.code}): ${error.message}`
          : error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason: `PAYMENT_FAILED: could not create refund invoice: ${reason}`,
          }) }],
        };
      }

      // Submit the refund request to the backend
      try {
        const refundResult = await client.requestRefund(
          args.verificationId,
          invoice.bolt11,
          args.preimage,
        );

        if (refundResult.refunded) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "REFUNDED",
              refundedAmountSats: refundAmountSats,
            }) }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "REFUND_FAILED",
              failureReason: "Backend rejected the refund request",
            }) }],
          };
        }
      } catch (error) {
        let failureReason: string;
        if (error instanceof AskAHumanError) {
          if (error.status === 400 || error.status === 409) {
            failureReason = `NOT_ELIGIBLE: ${error.message}`;
          } else if (error.status === 410) {
            failureReason = `REFUND_WINDOW_EXPIRED: ${error.message}`;
          } else {
            failureReason = `PAYMENT_FAILED: ${error.message}`;
          }
        } else {
          failureReason = `PAYMENT_FAILED: ${error instanceof Error ? error.message : String(error)}`;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            status: "REFUND_FAILED",
            failureReason,
          }) }],
        };
      }
    },
  );
}
