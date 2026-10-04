/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import app from '../../App.tsx?raw';
import composer from './ChatComposer.tsx?raw';

describe('attachment batch validation', () => {
  it('skips rejected-only reads', () => {
    expect(app).toContain('if (!accepted.length) return;');
  });
  it('preserves mixed batch errors after successful reads', () => {
    expect(app).toContain('if (accepted.length === files.length) clearError();');
  });
  it('does not advertise binary PDF extraction unsupported by backend', () => {
    expect(app).not.toContain("'application/pdf'");
    expect(app).not.toContain('|pdf)');
    expect(composer).not.toContain('.pdf');
  });
});
