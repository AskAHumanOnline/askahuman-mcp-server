/**
 * In-process credential store: holds L402 payment preimages keyed on verificationId.
 * Preimages are stored with a TTL and never leave the process boundary.
 * The store is consulted by request_refund instead of accepting preimage from the agent.
 */

const CREDENTIAL_TTL_MS = 8 * 24 * 60 * 60 * 1_000; // 8 days (refund window is 7 days)

/** Interval between background sweeps that evict expired entries. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

interface CredentialEntry {
  readonly expiresAt: number;
}

export class CredentialStore {
  private readonly store = new Map<string, CredentialEntry & { _preimage: string }>();
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

  /** Store the preimage for a verification. Automatically expires after TTL. */
  set(verificationId: string, preimage: string): void {
    const entry = { expiresAt: Date.now() + CREDENTIAL_TTL_MS } as CredentialEntry & { _preimage: string };
    Object.defineProperty(entry, '_preimage', { value: preimage, enumerable: false, writable: false });
    this.store.set(verificationId, entry);
  }

  /** Retrieve the preimage. Returns undefined if not found or expired. */
  get(verificationId: string): string | undefined {
    const entry = this.store.get(verificationId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(verificationId);
      return undefined;
    }
    return entry._preimage;
  }

  /** Remove a credential after successful use (e.g., refund completed). */
  delete(verificationId: string): void {
    this.store.delete(verificationId);
  }

  /** Stop the background sweep. Call on shutdown or in test teardown. */
  destroy(): void {
    clearInterval(this.sweepInterval);
  }
}
