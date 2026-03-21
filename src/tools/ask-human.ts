/**
 * ask_human tool: submit a verification request, pay via Lightning, and return immediately.
 * The caller must poll check_verification to retrieve the human's answer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { L402Service } from "../services/l402-service.js";
import type { AskAHumanClient } from "../services/askahuman-client.js";
import type { CredentialStore } from "../services/credential-store.js";
import { type CreateVerificationRequest, TaskType } from "../types.js";

export function registerAskHuman(
  server: McpServer,
  _config: Config,
  l402Service: L402Service,
  client: AskAHumanClient,
  credentialStore: CredentialStore,
): void {
  server.tool(
    "ask_human",
    "Submit a question for human verification and pay via Lightning Network. Returns immediately with a verificationId after payment succeeds. You must then poll check_verification with the returned verificationId to retrieve the human's answer.",
    {
      question: z.string().min(1).max(2000).describe("The question or task for the human verifier"),
      taskType: z.enum(["BINARY_DECISION", "MULTIPLE_CHOICE", "TEXT_RESPONSE"]).describe("Type of verification task"),
      context: z.string().max(4000).optional().describe("Additional context to help the verifier"),
      choices: z.array(z.string().max(500)).max(20).optional().describe("Answer options for MULTIPLE_CHOICE tasks"),
      callbackUrl: z.string().url().optional().describe("Webhook URL for async result delivery"),
      urgent: z.boolean().optional().default(false).describe("Pay priority rate for faster handling"),
      maxBudgetSats: z.number().int().positive().optional().describe("Maximum sats willing to pay (server enforces minimum)"),
      maxWaitMinutes: z.number().int().min(30).max(1440).optional().default(240).describe("Max minutes before task expires in queue"),
    },
    async (args) => {
      // Pre-fetch server pricing to determine amountSats (required by backend)
      let amountSats: number;
      try {
        const pricing = await client.getPricing();
        const taskPricing = pricing.taskTypes.find((p) => p.id === args.taskType);
        if (!taskPricing) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: "UNKNOWN_TASK_TYPE",
              message: `Server does not support task type: ${args.taskType}`,
            }) }],
          };
        }
        const serverPrice = args.urgent ? taskPricing.urgentPriceSats : taskPricing.basePriceSats;
        if (args.maxBudgetSats !== undefined && args.maxBudgetSats < serverPrice) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: "BUDGET_EXCEEDED",
              message: `Server requires ${serverPrice} sats for ${args.taskType} but maxBudgetSats is ${args.maxBudgetSats}. Increase your budget or omit maxBudgetSats to pay the server price.`,
            }) }],
          };
        }
        // Use maxBudgetSats as the offer if higher than server price (agent can pay more, never less)
        amountSats = args.maxBudgetSats ?? serverPrice;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "PRICING_FAILED",
            message: `Failed to fetch server pricing: ${message}`,
          }) }],
        };
      }

      // Build the verification request
      const req: CreateVerificationRequest = {
        agentId: "askahuman-mcp-agent",
        taskType: args.taskType as TaskType,
        taskData: {
          question: args.question,
          ...(args.context && { context: args.context }),
          ...(args.choices && { choices: args.choices }),
        },
        amountSats,
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

      credentialStore.set(credentials.verificationId, credentials.getPreimage());
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

      // Return immediately -- the task is queued for human verification
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "PENDING",
          verificationId,
          taskType: args.taskType,
          amountPaidSats: amountSats,
          message: "Task queued for human verification. Call check_verification with verificationId to poll for the result.",
          instructions: "Poll check_verification every 30-60 seconds until status is COMPLETED. The result will contain the human's answer.",
        }) }],
      };
    },
  );
}
