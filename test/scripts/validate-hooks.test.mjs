// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../scripts/validate-hooks.mjs';

describe('validate-hooks main()', () => {
  it('returns 0 for the real (good) manifest', async () => {
    const code = await main([]);
    assert.equal(code, 0);
  });
});
