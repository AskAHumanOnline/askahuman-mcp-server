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
      store.set('vid-1', 'preimage-abc');
      expect(store.get('vid-1')).toBe('preimage-abc');
    });

    it('returns undefined for unknown verificationId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('deletes a credential', () => {
      store.set('vid-1', 'preimage-abc');
      store.delete('vid-1');
      expect(store.get('vid-1')).toBeUndefined();
    });

    it('overwrites existing entry on second set', () => {
      store.set('vid-1', 'preimage-1');
      store.set('vid-1', 'preimage-2');
      expect(store.get('vid-1')).toBe('preimage-2');
    });

    it('delete is safe on nonexistent key', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined for expired entries', () => {
      jest.useFakeTimers();

      store.set('vid-1', 'preimage-abc');
      expect(store.get('vid-1')).toBe('preimage-abc');

      // Advance past the 8-day TTL
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000 + 1;
      jest.advanceTimersByTime(EIGHT_DAYS_MS);

      expect(store.get('vid-1')).toBeUndefined();
    });

    it('returns value before TTL expires', () => {
      jest.useFakeTimers();

      store.set('vid-1', 'preimage-abc');

      // Advance to just before the 8-day TTL
      const ALMOST_EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000 - 1000;
      jest.advanceTimersByTime(ALMOST_EIGHT_DAYS_MS);

      expect(store.get('vid-1')).toBe('preimage-abc');
    });
  });

  describe('background sweep', () => {
    it('removes expired entries after sweep interval', () => {
      jest.useFakeTimers();
      // Create store AFTER enabling fake timers so the interval is captured
      store.destroy(); // clean up the one from beforeEach
      store = new CredentialStore();

      store.set('vid-1', 'preimage-1');
      store.set('vid-2', 'preimage-2');

      // Advance past the 8-day TTL — the 1-hour sweep will have fired many times
      const EIGHT_DAYS_PLUS = 8 * 24 * 60 * 60 * 1000 + 1;
      jest.advanceTimersByTime(EIGHT_DAYS_PLUS);

      // Add a fresh entry to confirm store still works
      store.set('vid-3', 'preimage-3');
      expect(store.get('vid-3')).toBe('preimage-3');

      // The expired entries should have been swept
      expect(store.get('vid-1')).toBeUndefined();
      expect(store.get('vid-2')).toBeUndefined();
    });

    it('does not remove entries that have not yet expired', () => {
      jest.useFakeTimers();
      store.destroy();
      store = new CredentialStore();

      store.set('vid-1', 'preimage-1');

      // Advance by 1 hour (sweep fires) but entry has 8-day TTL — should survive
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
      store.set('vid-1', 'secret-preimage');
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
});
