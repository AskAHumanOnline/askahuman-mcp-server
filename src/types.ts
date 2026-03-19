/**
 * Shared TypeScript types for the MCP server.
 */

export enum VerificationStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  IN_QUEUE = 'IN_QUEUE',
  ASSIGNED = 'ASSIGNED',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  EXPIRED_UNCLAIMED = 'EXPIRED_UNCLAIMED',
  REFUNDED = 'REFUNDED',
}

export enum TaskType {
  BINARY_DECISION = 'BINARY_DECISION',
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  TEXT_RESPONSE = 'TEXT_RESPONSE',
}

export interface VerificationResult {
  answer: string;
  confidence?: number;
  verifierTrustLevel?: string;
}

export interface VerificationResponse {
  verificationId: string;
  status: VerificationStatus;
  result?: VerificationResult;
  createdAt: string;
  expiresAt?: string;
  queueExpiresAt?: string;
  refundEligible?: boolean;
  refundDeadline?: string;
  amountSats?: number;
  totalInvoiceSats?: number;
}

export interface TierPricing {
  verifierPayoutSats: number;
  platformFeeSats: number;
  totalSats: number;
}

export interface TaskTypePricing {
  id: string;
  displayName: string;
  description: string;
  basePriceSats: number;
  urgentPriceSats: number;
  tierPricing: Record<string, TierPricing>;
}

export interface PricingResponse {
  taskTypes: TaskTypePricing[];
  urgentMultiplier: number;
}

export interface CreateVerificationRequest {
  agentId: string;
  taskType: TaskType;
  taskData: {
    question: string;
    context?: string;
    choices?: string[];
  };
  amountSats?: number;
  callbackUrl?: string;
  maxWaitMinutes?: number;
  maxBudgetSats?: number;
}

export interface PaymentChallenge {
  verificationId: string;
  macaroon: string;
  invoice: string;
  amountSats: number;
}

export interface LndPayInvoiceResponse {
  payment_preimage: string;
  payment_hash: string;
  payment_route?: object;
}

export interface LndAddInvoiceRequest {
  value: number;
  memo?: string;
  expiry?: number;
}

export interface LndAddInvoiceResponse {
  payment_request: string;
  r_hash: string;
  add_index: string;
}
