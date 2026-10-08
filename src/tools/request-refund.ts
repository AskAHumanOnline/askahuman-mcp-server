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
import type { CredentialStore } from "../services/credential-store.js";
import { VerificationStatus } from "../types.js";

/**
 * Refund invoice validity. The backend binds a refund to the first invoice it sees and refuses any
 * other one, so the invoice must stay payable for the whole retry window (refund window is 7 days;
 * LND's default of 1 hour would strand the refund after a transient failure).
 */
const REFUND_INVOICE_EXPIRY_SECONDS = 8 * 24 * 60 * 60;

/** Extract the machine-readable `error` code from a backend error body, if it is JSON. */
function backendErrorCode(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON: fall through to the generic mapping.
  }
  return undefined;
}

/** Tool result body for a concurrent call that lost the per-verification lock. */
const REFUND_IN_PROGRESS_RESULT = {
  content: [{ type: "text" as const, text: JSON.stringify({
    status: "REFUND_FAILED",
    failureReason: "REFUND_IN_PROGRESS: a refund request for this verification is already running. Do not retry yet; call check_verification until the status is REFUNDED or EXPIRED_UNCLAIMED.",
  }) }],
};

export function registerRequestRefund(
  server: McpServer,
  client: AskAHumanClient,
  lightning: LightningService,
  credentialStore: CredentialStore,
): void {
  // Verifications with a refund call currently running. Two overlapping calls would each create a
  // refund invoice, and the backend binds the refund to whichever it sees first; fail the second fast.
  const inFlight = new Set<string>();

  server.tool(
    "request_refund",
    "Request a full refund for a paid verification task that expired without being claimed by a human verifier. The payment credential is held server-side -- no preimage needed.",
    {
      verificationId: z.string().uuid().describe("The ID of the expired verification request"),
    },
    async (args) => {
      if (inFlight.has(args.verificationId)) return REFUND_IN_PROGRESS_RESULT;
      inFlight.add(args.verificationId);
      try {
        return await handleRefund(args.verificationId);
      } finally {
        inFlight.delete(args.verificationId);
      }
    },
  );

  async function handleRefund(verificationId: string) {
    const args = { verificationId };
    // Confirm refund eligibility by checking current status (owner view: includes the invoice total)
    let v;
    try {
      v = await client.getVerification(args.verificationId, credentialStore.getProof(args.verificationId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "REFUND_FAILED",
          failureReason: `Could not check verification status: ${message}`,
        }) }],
      };
    }

    if (v.status === VerificationStatus.REFUND_PENDING) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "REFUND_FAILED",
          failureReason: "REFUND_IN_PROGRESS: a refund payment is already in flight. Do not retry yet; call check_verification until the status is REFUNDED or EXPIRED_UNCLAIMED.",
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

    // Look up the preimage from the credential store (never exposed to the agent)
    const preimage = credentialStore.get(args.verificationId);
    if (!preimage) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "REFUND_FAILED",
          failureReason: "CREDENTIAL_EXPIRED: payment credential not found in server memory. This may happen if the server was restarted since the original payment. Contact support with your verificationId.",
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

    // Reuse the refund invoice from an earlier attempt: the backend binds the refund to the first
    // invoice's payment hash, so a retry with a fresh invoice is refused (409 REFUND_INVOICE_MISMATCH).
    // Only a first attempt creates an invoice on the agent's LND node.
    let refundInvoice = credentialStore.getRefundInvoice(args.verificationId);
    try {
      if (!refundInvoice) {
        const invoice = await lightning.createInvoice(
          refundAmountSats,
          "AskAHuman refund",
          REFUND_INVOICE_EXPIRY_SECONDS,
        );
        refundInvoice = invoice.bolt11;
        credentialStore.setRefundInvoice(args.verificationId, refundInvoice);
      }
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
        refundInvoice,
        preimage,
      );

      if (refundResult.refunded) {
        // Keep the credential until its TTL so check_verification still reaches the terminal REFUNDED state.
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
        if (error.status === 409 && backendErrorCode(error.body) === "REFUND_INVOICE_MISMATCH") {
          failureReason = "REFUND_INVOICE_MISMATCH: an earlier refund attempt is bound to a different invoice. Contact support with your verificationId; do not retry with a new invoice.";
        } else if (error.status === 400 || error.status === 409) {
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
  }
}
