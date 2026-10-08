/**
 * In-process credential store: holds the L402 credential (macaroon + payment preimage)
 * and the refund invoice, keyed on verificationId.
 * Secrets are stored with a TTL, never leave the process boundary and are never exposed to the agent.
 * The store is consulted by check_verification (to prove ownership when reading a result)
 * and by request_refund (instead of accepting a preimage from the agent).
 */

const CREDENTIAL_TTL_MS = 10 * 24 * 60 * 60 * 1_000; // 10 days (refund window is 7 days from creation; outlives the 8-day refund invoice)

/** Interval between background sweeps that evict expired entries. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

/** The proof of payment sent as `Authorization: L402 <macaroon>:<preimage>`. */
export interface L402Proof {
  readonly macaroon: string;
  readonly preimage: string;
}

interface CredentialEntry {
  readonly expiresAt: number;
  /** BOLT11 refund invoice bound to the first refund attempt (the backend refuses any other one). */
  refundInvoice?: string;
}

type StoredEntry = CredentialEntry & { _preimage: string; _macaroon: string };

export class CredentialStore {
  private readonly store = new Map<string, StoredEntry>();
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Background sweep: evict all expired entries every hour.
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.store) {
        if (now > entry.expiresAt) {
          this.store.delete(id);
        }
      }
    }, SWEEP_INTERVAL_MS);
    // Allow the process to exit even if the interval is still active.
    this.sweepInterval.unref();
  }

  /** Store the credential for a verification. Automatically expires after TTL. */
  set(verificationId: string, preimage: string, macaroon: string): void {
    const entry = { expiresAt: Date.now() + CREDENTIAL_TTL_MS } as StoredEntry;
    // Non-enumerable so the secrets never show up in JSON.stringify / Object.keys / console.log.
    Object.defineProperty(entry, '_preimage', { value: preimage, enumerable: false, writable: false });
    Object.defineProperty(entry, '_macaroon', { value: macaroon, enumerable: false, writable: false });
    this.store.set(verificationId, entry);
  }

  /** Retrieve the preimage. Returns undefined if not found or expired. */
  get(verificationId: string): string | undefined {
    return this.live(verificationId)?._preimage;
  }

  /** Retrieve the full L402 proof. Returns undefined if not found or expired. */
  getProof(verificationId: string): L402Proof | undefined {
    const entry = this.live(verificationId);
    return entry ? { macaroon: entry._macaroon, preimage: entry._preimage } : undefined;
  }

  /** Retrieve the refund invoice bound to this verification, if a refund was already attempted. */
  getRefundInvoice(verificationId: string): string | undefined {
    return this.live(verificationId)?.refundInvoice;
  }

  /** Remember the refund invoice so every retry presents the same payment hash. No-op if the credential is gone. */
  setRefundInvoice(verificationId: string, bolt11: string): void {
    const entry = this.live(verificationId);
    if (entry) entry.refundInvoice = bolt11;
  }

  /** Remove a credential after successful use (e.g., refund completed). */
  delete(verificationId: string): void {
    this.store.delete(verificationId);
  }

  /** Stop the background sweep. Call on shutdown or in test teardown. */
  destroy(): void {
    clearInterval(this.sweepInterval);
  }

  private live(verificationId: string): StoredEntry | undefined {
    const entry = this.store.get(verificationId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(verificationId);
      return undefined;
    }
    return entry;
  }
}
