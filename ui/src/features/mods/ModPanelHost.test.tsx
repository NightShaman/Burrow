import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModPanelHost } from './ModPanelHost';

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('mod panel host', () => {
  it('isolates a failed control module and keeps the main app usable', async () => {
    render(<ModPanelHost panel={{ modId: 'missing-mod', name: 'Missing Mod', controlUrl: '/api/mods/missing-mod/ui/control.js' }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load|failed|fetch|unknown|cannot find module/i);
    expect(screen.getByText('Missing Mod unavailable')).toBeTruthy();
  });
});
