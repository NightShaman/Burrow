import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedProvider } from '../../app/types';
import { ProviderModelFields } from './ProviderModelFields';

const providers: SavedProvider[] = [
  { id: 'a', provider: 'Same', apiType: '', url: '', apiKey: '', models: ['shared', 'only-a', 'shared'], modelLabels: { shared: 'Friendly' } },
  { id: 'b', provider: 'Same', apiType: '', url: '', apiKey: '', models: ['shared', 'only-b'] },
  { id: 'empty', provider: 'Empty', apiType: '', url: '', apiKey: '', models: [] },
];
afterEach(cleanup);
describe('ProviderModelFields', () => {
  it('uses readable names without UUIDs and keeps both fields in one shared row', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    render(<ProviderModelFields providers={[{ ...providers[0], id, provider: 'My saved connection' }]} connectionId={id} model="shared" onChange={vi.fn()} />);
    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(provider.selectedOptions[0].textContent).toBe('My saved connection');
    expect(provider.parentElement?.parentElement).toBe(screen.getByLabelText('Model').parentElement?.parentElement);
    expect(provider.parentElement?.parentElement?.className).toBe('field-pair provider-model-fields');
    expect(screen.queryByText(new RegExp(id))).toBeNull();
  });
  it('filters models by exact connection and deduplicates model IDs with display labels', () => {
    const onChange = vi.fn();
    const view = render(<ProviderModelFields providers={providers} connectionId="a" model="shared" onChange={onChange} />);
    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...model.options].map(option => option.value)).toEqual(['', 'shared', 'only-a']);
    expect(model.selectedOptions[0].textContent).toBe('Friendly');
    expect(screen.getByRole('option', { name: 'Same · 1' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Same · 2' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenLastCalledWith('b', 'shared');
    view.rerender(<ProviderModelFields providers={providers} connectionId="b" model="shared" onChange={onChange} />);
    expect([...model.options].map(option => option.value)).toEqual(['', 'shared', 'only-b']);
    fireEvent.change(model, { target: { value: 'only-b' } });
    expect(onChange).toHaveBeenLastCalledWith('b', 'only-b');
  });
  it('retains unavailable persisted values on load and provider refresh without changes', () => {
    const onChange = vi.fn();
    const view = render(<ProviderModelFields providers={providers} connectionId="missing" model="gone" onChange={onChange} />);
    expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'missing');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'gone');
    expect(screen.getByLabelText('Model')).toHaveProperty('disabled', true);
    view.rerender(<ProviderModelFields providers={providers} connectionId="a" model="gone" onChange={onChange} />);
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'gone');
    expect(screen.getByRole('option', { name: 'Unavailable · gone' })).toBeTruthy();
    view.rerender(<ProviderModelFields providers={[]} connectionId="a" model="gone" onChange={onChange} />);
    expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'a');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('keeps empty model selection attached to its provider; only provider clearing inherits', () => {
    const onChange = vi.fn();
    render(<ProviderModelFields providers={providers} connectionId="a" model="shared" inheritLabel="Inherit" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('a', null);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'empty' } });
    expect(onChange).toHaveBeenLastCalledWith('empty', null);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null, null);
  });
});
