import { afterEach, expect, it, vi } from 'vitest';
import { secureUuid } from './secureUuid';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses native randomUUID when available', () => {
 const native = vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555');
 expect(secureUuid()).toBe('11111111-2222-4333-8444-555555555555');
 expect(native).toHaveBeenCalledOnce();
});
it('uses cryptographic bytes for RFC 4122 v4 when randomUUID is unavailable', () => {
 vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
 expect(typeof crypto.randomUUID).toBe('undefined');
 const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('insecure randomness'); });
 expect(secureUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 expect(random).not.toHaveBeenCalled();
});
