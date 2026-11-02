import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { ModSettingsHost } from './ModSettingsHost';
afterEach(cleanup);
it('mounts the actual mixed browser fixture and navigates every renderer contract', async () => {
  const navigation = document.createElement('div');
  const overflow = document.createElement('div');
  document.body.append(navigation, overflow);
  try {
    const { container, unmount } = render(
      <ConfirmProvider>
        <ModSettingsHost
          modId="fixture-extension"
          settingsUrl="../../../scripts/fidgit-settings-fixture/fixture-mod.js"
          agents={[]}
          onAgentsChanged={async () => {}}
          navigationTarget={navigation}
          overflowTarget={overflow}
        />
      </ConfirmProvider>,
    );
    await screen.findByRole('heading', { name: 'Fixture extension overview' });
    const host = container.querySelector('.mod-settings-mount');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await screen.findByRole('heading', { name: 'Fixture extension advanced' });
    expect(host?.getAttribute('data-settings-layout')).toBe('imperative');
    fireEvent.click(screen.getByRole('button', { name: 'Form' }));
    await screen.findByDisplayValue('Synthetic declarative form');
    expect(host?.getAttribute('data-settings-layout')).toBe('form');
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(await screen.findByRole('button', { name: /Synthetic item 3/ }));
    await screen.findByDisplayValue('Synthetic value 3');
    expect(overflow.querySelector('[aria-pressed="true"]')?.textContent).toContain(
      'Synthetic item 3',
    );
    expect(host?.getAttribute('data-settings-layout')).toBe('form-inventory');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: /Synthetic item 3/ }));
    await screen.findByText('Validated detail for synthetic item 3.');
    expect(overflow.textContent).toContain('Validated detail for synthetic item 3.');
    expect(host?.getAttribute('data-settings-layout')).toBe('list-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await screen.findByRole('heading', { name: 'Activity' });
    expect(screen.getAllByText(/Synthetic item [123]/)).toHaveLength(3);
    expect(host?.getAttribute('data-settings-layout')).toBe('activity');
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    await screen.findByRole('heading', { name: 'Fixture extension overview' });
    expect(container.querySelector('.mod-settings-mount')).toBe(host);
    expect(overflow.textContent).toContain('Extension context');
    unmount();
    expect(overflow.childElementCount).toBe(0);
  } finally {
    navigation.remove();
    overflow.remove();
  }
});
