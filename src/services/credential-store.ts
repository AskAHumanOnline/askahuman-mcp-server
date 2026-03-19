/**
 * In-process credential store: holds L402 payment preimages keyed on verificationId.
 * Preimages are stored with a TTL and never leave the process boundary.
 * The store is consulted by request_refund instead of accepting preimage from the agent.
 */

const CREDENTIAL_TTL_MS = 8 * 24 * 60 * 60 * 1_000; // 8 days (refund window is 7 days)

interface CredentialEntry {
  readonly expiresAt: number;
}

export class CredentialStore {
  private readonly store = new Map<string, CredentialEntry & { _preimage: string }>();

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
}
