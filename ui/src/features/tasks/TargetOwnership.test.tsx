import { expect, it } from 'vitest';
import { localRuntimeKey } from '../../app/useOwnedApi';
it('uses one stable local runtime identity', () => { expect(localRuntimeKey()).toBe('local'); });
