/**
 * ask_human tool: submit a verification request, pay via Lightning, poll for result.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { L402Service } from "../services/l402-service.js";
import type { AskAHumanClient } from "../services/askahuman-client.js";
import { type CreateVerificationRequest, TaskType, VerificationStatus } from "../types.js";

const POLL_START_MS = 1_000;
const POLL_MAX_MS = 30_000;
const DEFAULT_MAX_POLL_MS = 10 * 60 * 1_000; // 10 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAskHuman(
  server: McpServer,
  _config: Config,
  l402Service: L402Service,
  client: AskAHumanClient,
): void {
  server.tool(
    "ask_human",
    "Submit a question for human verification, pay via Lightning Network, and wait for the result. Returns the human's answer or an error with refund guidance if the task expires.",
    {
      question: z.string().min(1).describe("The question or task for the human verifier"),
      taskType: z.enum(["BINARY_DECISION", "MULTIPLE_CHOICE", "TEXT_RESPONSE"]).describe("Type of verification task"),
      context: z.string().optional().describe("Additional context to help the verifier"),
      choices: z.array(z.string()).optional().describe("Answer options for MULTIPLE_CHOICE tasks"),
      callbackUrl: z.string().url().optional().describe("Webhook URL for async result delivery"),
      urgent: z.boolean().optional().default(false).describe("Pay priority rate for faster handling"),
      maxBudgetSats: z.number().int().positive().optional().describe("Maximum sats willing to pay (server enforces minimum)"),
      maxWaitMinutes: z.number().int().min(30).max(1440).optional().default(240).describe("Max minutes before task expires in queue"),
    },
    async (args) => {
      // Build the verification request
      const req: CreateVerificationRequest = {
        agentId: "askahuman-mcp-agent",
        taskType: args.taskType as TaskType,
        taskData: {
          question: args.question,
          ...(args.context && { context: args.context }),
          ...(args.choices && { choices: args.choices }),
        },
        ...(args.maxBudgetSats !== undefined && { maxBudgetSats: args.maxBudgetSats }),
        ...(args.maxWaitMinutes !== undefined && { maxWaitMinutes: args.maxWaitMinutes }),
        ...(args.callbackUrl !== undefined && { callbackUrl: args.callbackUrl }),
      };

      // Authenticate via L402 (get 402 challenge, pay invoice, get credentials)
      let credentials;
      try {
        credentials = await l402Service.authenticate(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "PAYMENT_FAILED",
            message: `Failed to complete L402 payment: ${message}`,
          }) }],
        };
      }

      const verificationId = credentials.verificationId;

      // Submit the authenticated request
      try {
        await client.submitVerificationWithL402(
          req,
          credentials.macaroon,
          credentials.getPreimage(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "SUBMISSION_FAILED",
            verificationId,
            message: `Payment succeeded but submission failed: ${message}. Use check_verification to monitor status.`,
          }) }],
        };
      }

      // Poll for result with exponential backoff
      let intervalMs = POLL_START_MS;
      const startTime = Date.now();
      const maxPollMs = DEFAULT_MAX_POLL_MS;

      while (true) {
        await sleep(intervalMs);
        intervalMs = Math.min(intervalMs * 2, POLL_MAX_MS);

        let verification;
        try {
          verification = await client.getVerification(verificationId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Transient poll failure -- keep trying until timeout
          if (Date.now() - startTime > maxPollMs) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "TIMEOUT",
                verificationId,
                message: `Polling failed and timeout elapsed: ${message}. Use check_verification to monitor.`,
              }) }],
            };
          }
          continue;
        }

        switch (verification.status) {
          case VerificationStatus.COMPLETED:
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                verificationId,
                status: "COMPLETED",
                result: verification.result,
                invoiceAmountSats: verification.totalInvoiceSats ?? verification.amountSats,
              }) }],
            };

          case VerificationStatus.EXPIRED_UNCLAIMED:
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "EXPIRED_UNCLAIMED",
                verificationId,
                refundEligible: verification.refundEligible ?? true,
                refundDeadline: verification.refundDeadline,
                preimage: credentials.getPreimage(),
                message: "Task expired without being claimed by a verifier. Call request_refund with this verificationId and preimage to reclaim your sats.",
              }) }],
            };

          case VerificationStatus.EXPIRED:
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "EXPIRED",
                verificationId,
                message: "Verification invoice expired before payment was confirmed.",
              }) }],
            };

          case VerificationStatus.REFUNDED:
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "ALREADY_REFUNDED",
                verificationId,
                message: "This verification has already been refunded.",
              }) }],
            };
        }

        // Check agent-side timeout
        if (Date.now() - startTime > maxPollMs) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: "TIMEOUT",
              verificationId,
              status: verification.status,
              message: "Polling timeout elapsed. The task is still live. Call check_verification to monitor it or cancel_verification to check refund eligibility.",
            }) }],
          };
        }
      }
    },
  );
}
