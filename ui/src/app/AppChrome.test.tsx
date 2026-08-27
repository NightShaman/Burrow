import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Tab } from './types';
import { AppStatusBar, DocumentTabs } from './AppChrome';

const tabs: Tab[] = [
  { id: 'chat', label: 'Chat', kind: 'chat' },
  { id: 'group:local:design', label: 'Design', kind: 'group', channelId: 'design', targetId: 'local' },
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
  it('clamps usage percentages and exposes semantic progress values', () => {
    render(<AppStatusBar
      anthropicUsage={{ windows: [{ key: 'five_hour', usedPercent: 25 }] }}
      openAiUsage={{ windows: [{ key: 'primary', label: 'Weekly', usedPercent: 125 }] }}
      runtimeVersion="1.2.3"
    />);

    expect(screen.getByRole('progressbar', { name: '5hr usage remaining' }).getAttribute('aria-valuenow')).toBe('75');
    expect(screen.getByRole('progressbar', { name: 'Weekly usage remaining' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('v. 1.2.3')).toBeTruthy();
  });
});
