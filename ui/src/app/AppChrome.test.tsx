import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Tab } from './types';
import { AppStatusBar, DocumentTabs } from './AppChrome';

vi.mock('./ProviderPoolMetrics', () => ({ ProviderPoolMetrics: () => <div>Pool metrics</div> }));

const tabs: Tab[] = [
  { id: 'chat', label: 'Chat', kind: 'chat' },
  {
    id: 'group:local:design',
    label: 'Design',
    kind: 'group',
    channelId: 'design',
    targetId: 'local',
  },
];

describe('DocumentTabs', () => {
  it('renders selection and close actions as separate buttons', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<DocumentTabs tabs={tabs} activeTabId="chat" onSelect={onSelect} onClose={onClose} />);

    const chat = screen.getByRole('tab', { name: 'Chat' });
    const design = screen.getByRole('tab', { name: 'Design' });
    const close = screen.getByRole('button', { name: 'Close Design' });

    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(design.getAttribute('aria-selected')).toBe('false');
    expect(design.contains(close)).toBe(false);

    fireEvent.click(design);
    fireEvent.click(close);
    expect(onSelect).toHaveBeenCalledWith('group:local:design');
    expect(onClose).toHaveBeenCalledWith('group:local:design');
  });
});

describe('AppStatusBar', () => {
  it('renders pool metrics and version without provider quota indicators', () => {
    const { container } = render(<AppStatusBar runtimeVersion="1.2.3" />);

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('.usage-meter')).toBeNull();
    expect(screen.queryByText(/5hr|7day|Weekly/)).toBeNull();
    expect(screen.getByText('Pool metrics')).toBeTruthy();
    expect(screen.getByText('v. 1.2.3').getAttribute('title')).toBeNull();
    expect(screen.queryByText(/UI|BE|ASM/)).toBeNull();
  });

  it('preserves the stale registry warning and missing version fallback', () => {
    render(<AppStatusBar registryStale />);
    expect(screen.getByRole('status').textContent).toBe('Agents stale');
    expect(screen.getByText('v. —')).toBeTruthy();
  });
});
