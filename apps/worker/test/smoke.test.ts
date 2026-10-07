import { describe, it, expect } from 'vitest';
import { LlmError } from '../src/extract/types.js';

describe('smoke', () => {
  it('resolves .js imports to TypeScript sources', () => {
    const e = new LlmError('x', 'auth', 'p', 'm');
    expect(e.category).toBe('auth');
  });
});
