/**
 * Unit tests for CredentialStore.
 */

import { CredentialStore } from '../../src/services/credential-store.js';

describe('CredentialStore', () => {
  let store: CredentialStore;

  beforeEach(() => {
    store = new CredentialStore();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    store.destroy();
    jest.useRealTimers();
  });

  describe('set/get/delete', () => {
    it('stores and retrieves a preimage', () => {
      store.set('vid-1', 'preimage-abc', 'mac-vid-1');
      expect(store.get('vid-1')).toBe('preimage-abc');
    });

    it('returns undefined for unknown verificationId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('deletes a credential', () => {
      store.set('vid-1', 'preimage-abc', 'mac-vid-1');
      store.delete('vid-1');
      expect(store.get('vid-1')).toBeUndefined();
    });

    it('overwrites existing entry on second set', () => {
      store.set('vid-1', 'preimage-1', 'mac-vid-1');
      store.set('vid-1', 'preimage-2', 'mac-vid-1');
      expect(store.get('vid-1')).toBe('preimage-2');
    });

    it('delete is safe on nonexistent key', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined for expired entries', () => {
      jest.useFakeTimers();

      store.set('vid-1', 'preimage-abc', 'mac-vid-1');
      expect(store.get('vid-1')).toBe('preimage-abc');

      // Advance past the 10-day TTL
      const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000 + 1;
      jest.advanceTimersByTime(TEN_DAYS_MS);

      expect(store.get('vid-1')).toBeUndefined();
    });

    it('returns value before TTL expires', () => {
      jest.useFakeTimers();

      store.set('vid-1', 'preimage-abc', 'mac-vid-1');

      // Advance to just before the 10-day TTL
      const ALMOST_TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000 - 1000;
      jest.advanceTimersByTime(ALMOST_TEN_DAYS_MS);

      expect(store.get('vid-1')).toBe('preimage-abc');
    });
  });

  describe('background sweep', () => {
    it('removes expired entries after sweep interval', () => {
      jest.useFakeTimers();
      // Create store AFTER enabling fake timers so the interval is captured
      store.destroy(); // clean up the one from beforeEach
      store = new CredentialStore();

      store.set('vid-1', 'preimage-1', 'mac-vid-1');
      store.set('vid-2', 'preimage-2', 'mac-vid-2');

      // Advance past the 10-day TTL — the 1-hour sweep will have fired many times
      const TEN_DAYS_PLUS = 10 * 24 * 60 * 60 * 1000 + 1;
      jest.advanceTimersByTime(TEN_DAYS_PLUS);

      // Add a fresh entry to confirm store still works
      store.set('vid-3', 'preimage-3', 'mac-vid-3');
      expect(store.get('vid-3')).toBe('preimage-3');

      // The expired entries should have been swept
      expect(store.get('vid-1')).toBeUndefined();
      expect(store.get('vid-2')).toBeUndefined();
    });

    it('does not remove entries that have not yet expired', () => {
      jest.useFakeTimers();
      store.destroy();
      store = new CredentialStore();

      store.set('vid-1', 'preimage-1', 'mac-vid-1');

      // Advance by 1 hour (sweep fires) but entry has 10-day TTL — should survive
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(store.get('vid-1')).toBe('preimage-1');
    });

    it('destroy stops the sweep interval', () => {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      store.destroy();
      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe('preimage non-enumerability', () => {
    it('preimage is not exposed via JSON.stringify on internal entries', () => {
      store.set('vid-1', 'secret-preimage', 'mac-vid-1');
      // The preimage should be stored as non-enumerable property,
      // so even if someone serialized the store's internal map, it would not appear
      const value = store.get('vid-1');
      expect(value).toBe('secret-preimage');

      // The store itself should not leak preimages through serialization.
      // Use a replacer to handle the non-serializable interval reference.
      const serialized = JSON.stringify(store, (_key, value) => {
        if (typeof value === 'object' && value !== null && value.constructor?.name === 'Timeout') {
          return '[Timeout]';
        }
        return value as unknown;
      });
      expect(serialized).not.toContain('secret-preimage');
    });
  });
  describe('getProof', () => {
    it('returns macaroon and preimage', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      expect(store.getProof('vid-1')).toEqual({ macaroon: 'macaroon-xyz', preimage: 'preimage-abc' });
    });

    it('returns undefined for unknown verificationId', () => {
      expect(store.getProof('nonexistent')).toBeUndefined();
    });

    it('returns undefined after delete', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      store.delete('vid-1');
      expect(store.getProof('vid-1')).toBeUndefined();
    });

    it('returns undefined for expired entries', () => {
      jest.useFakeTimers();
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');

      jest.advanceTimersByTime(10 * 24 * 60 * 60 * 1000 + 1);

      expect(store.getProof('vid-1')).toBeUndefined();
    });

    it('returns the proof before TTL expires', () => {
      jest.useFakeTimers();
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');

      jest.advanceTimersByTime(10 * 24 * 60 * 60 * 1000 - 1000);

      expect(store.getProof('vid-1')).toEqual({ macaroon: 'macaroon-xyz', preimage: 'preimage-abc' });
    });
  });

  describe('refund invoice', () => {
    it('returns undefined before any refund attempt', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      expect(store.getRefundInvoice('vid-1')).toBeUndefined();
    });

    it('stores and retrieves the refund invoice', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      store.setRefundInvoice('vid-1', 'lnbc50n1refund');
      expect(store.getRefundInvoice('vid-1')).toBe('lnbc50n1refund');
    });

    it('does not disturb the stored proof', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      store.setRefundInvoice('vid-1', 'lnbc50n1refund');
      expect(store.getProof('vid-1')).toEqual({ macaroon: 'macaroon-xyz', preimage: 'preimage-abc' });
      expect(store.get('vid-1')).toBe('preimage-abc');
    });

    it('is a no-op when no credential exists', () => {
      store.setRefundInvoice('nonexistent', 'lnbc50n1refund');
      expect(store.getRefundInvoice('nonexistent')).toBeUndefined();
    });

    it('is removed together with the credential on delete', () => {
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      store.setRefundInvoice('vid-1', 'lnbc50n1refund');
      store.delete('vid-1');
      expect(store.getRefundInvoice('vid-1')).toBeUndefined();
    });

    it('returns undefined for expired entries', () => {
      jest.useFakeTimers();
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      store.setRefundInvoice('vid-1', 'lnbc50n1refund');

      jest.advanceTimersByTime(10 * 24 * 60 * 60 * 1000 + 1);

      expect(store.getRefundInvoice('vid-1')).toBeUndefined();
    });

    it('does not resurrect an expired credential', () => {
      jest.useFakeTimers();
      store.set('vid-1', 'preimage-abc', 'macaroon-xyz');
      jest.advanceTimersByTime(10 * 24 * 60 * 60 * 1000 + 1);

      store.setRefundInvoice('vid-1', 'lnbc50n1refund');

      expect(store.getRefundInvoice('vid-1')).toBeUndefined();
      expect(store.getProof('vid-1')).toBeUndefined();
    });
  });

  describe('secret non-enumerability', () => {
    it('does not expose macaroon or preimage in the serialized internal entry', () => {
      store.set('vid-1', 'secret-preimage', 'secret-macaroon');
      store.setRefundInvoice('vid-1', 'lnbc50n1refund');

      const internal = (store as unknown as { store: Map<string, object> }).store.get('vid-1');
      const serialized = JSON.stringify(internal);

      expect(serialized).not.toContain('secret-preimage');
      expect(serialized).not.toContain('secret-macaroon');
      expect(Object.keys(internal as object)).not.toContain('_preimage');
      expect(Object.keys(internal as object)).not.toContain('_macaroon');
    });
  });
});
