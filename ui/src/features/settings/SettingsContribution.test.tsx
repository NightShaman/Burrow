import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeclarativeSection } from './ModSettingsHost';
import { validateSettingsContribution } from './SettingsContribution';

describe('settings contribution list-detail items', () => {
  const assignments = {
    sections: [{
      id: 'assignments',
      label: 'Agent assignments',
      description: 'Choose where each agent executes future turns.',
      layout: 'form-inventory',
      items: [{
        id: 'smatchet',
        label: 'Smatchet',
        description: 'Controller-owned assignment.',
        meta: 'Local controller · /workspace',
        detail: 'Assignments apply to future turns only.',
        fields: [{ id: 'assignment-kind:smatchet', label: 'Runs on', control: 'select', value: 'local', options: [{ value: 'local', label: 'Local controller' }] }],
        actions: [{ id: 'save-assignment:smatchet', label: 'Save assignment', tone: 'primary' }],
      }],
    }],
  };

  it('preserves Agent Assignments items and nested fields/actions through validation', () => {
    const result = validateSettingsContribution(assignments);
    expect(result?.sections[0].items).toEqual([assignments.sections[0].items[0]]);
  });

  it('keeps the assignment form in primary and the saved agent list in overflow', () => {
    const contribution = validateSettingsContribution(assignments);
    expect(contribution).not.toBeNull();
    const overflow = document.createElement('div');
    render(<DeclarativeSection contribution={contribution!} section={contribution!.sections[0]} module={{}} overflowTarget={overflow} />);

    expect(within(overflow).getByRole('button', { name: 'Edit Smatchet' })).toBeTruthy();
    expect(within(document.body).getByLabelText('Runs on').tagName).toBe('SELECT');
    expect(within(document.body).getByRole('button', { name: 'Save assignment' })).toBeTruthy();
    expect(within(overflow).queryByRole('combobox')).toBeNull();
    expect(within(overflow).queryByRole('button', { name: 'Save assignment' })).toBeNull();
  });

  it('passes displayed item defaults when saving after selecting an item', async () => {
    const contribution = validateSettingsContribution({
      sections: [{
        id: 'assignments', label: 'Agent assignments', layout: 'form-inventory', items: [
          { id: 'local', label: 'Local', fields: [{ id: 'gateway:local', label: 'Gateway', value: 'local' }], actions: [{ id: 'save:local', label: 'Save' }] },
          { id: 'Hatchet', label: 'Hatchet', fields: [{ id: 'gateway:Hatchet', label: 'Gateway', value: 'Hatchet' }], actions: [{ id: 'save:Hatchet', label: 'Save' }] },
        ],
      }],
    });
    const handleSettingsAction = vi.fn().mockResolvedValue(undefined);
    const overflow = document.createElement('div');
    render(<DeclarativeSection contribution={contribution!} section={contribution!.sections[0]} module={{ handleSettingsAction }} overflowTarget={overflow} />);

    fireEvent.click(within(overflow).getByRole('button', { name: /Hatchet/ }));
    fireEvent.click(within(document.body).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(handleSettingsAction).toHaveBeenCalledWith('save:Hatchet', { 'gateway:local': 'local', 'gateway:Hatchet': 'Hatchet' }));
  });
});

describe('settings contribution item IDs', () => {
  const contribution = (items: unknown[]) => ({
    sections: [{ id: 'pairing', label: 'Pairing', layout: 'list-detail', items }],
  });

  it('preserves case-sensitive opaque item IDs and their actions', () => {
    const result = validateSettingsContribution(contribution([{ id: 'Hatchet', label: 'Hatchet', actions: [
      { id: 'approve-pairing:Hatchet', label: 'Approve', tone: 'primary' },
      { id: 'reject-pairing:Hatchet', label: 'Reject', tone: 'danger' },
    ] }]));
    expect(result?.sections[0].items?.[0].id).toBe('Hatchet');
    expect(result?.sections[0].items?.[0].actions?.map((action) => action.id)).toEqual(['approve-pairing:Hatchet', 'reject-pairing:Hatchet']);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['control character', 'Hatchet\u0000gateway'],
    ['too long', 'H'.repeat(129)],
  ])('rejects unsafe %s item IDs rather than silently dropping the item', (_label, id) => {
    expect(validateSettingsContribution(contribution([{ id, label: 'Unsafe' }]))).toBeNull();
  });
});

it('keeps the gateway form in primary and only saved cards with revoke in overflow', async () => {
  const contribution = validateSettingsContribution({ sections: [{ id: 'gateways', label: 'Gateways', layout: 'form-inventory', fields: [{ id: 'new-id', label: 'Gateway ID' }], actions: [{ id: 'enroll', label: 'Enroll or rotate gateway' }], items: ['Hatchet', 'Curator'].map(id => ({ id, label: id, metadata: [{ label: 'Version', value: '1.0' }], actions: [{ id: `revoke:${id}`, label: 'Revoke', tone: 'danger' }] })) }] });
  const overflow = document.createElement('div');
  const handleSettingsAction = vi.fn().mockResolvedValue(undefined);
  const view = render(<DeclarativeSection contribution={contribution!} section={contribution!.sections[0]} module={{ handleSettingsAction }} overflowTarget={overflow} />);
  expect(within(view.container).getByLabelText('Gateway ID')).toBeTruthy();
  expect(within(view.container).getByText('Enroll or rotate gateway')).toBeTruthy();
  expect(within(view.container).queryByText('Hatchet')).toBeNull();
  expect(within(overflow).getByText('Hatchet')).toBeTruthy();
  expect(within(overflow).getByText('Curator')).toBeTruthy();
  expect(within(overflow).queryByRole('textbox')).toBeNull();
  expect(within(overflow).getAllByRole('button').map(button => button.textContent)).toEqual(['Revoke', 'Revoke']);
  fireEvent.click(within(overflow).getAllByText('Revoke')[0]);
  await waitFor(() => expect(handleSettingsAction).toHaveBeenCalledWith('revoke:Hatchet', expect.anything()));
  expect(within(view.container).getByLabelText('Gateway ID')).toBeTruthy();
});

it('retains the form and inline inventory without an overflow target, including empty inventories', () => {
  const contribution = validateSettingsContribution({ sections: [{ id: 'gateways', label: 'Gateways', layout: 'form-inventory', fields: [{ id: 'gateway', label: 'Gateway ID' }], items: [] }] });
  const view = render(<DeclarativeSection contribution={contribution!} section={contribution!.sections[0]} module={{}} overflowTarget={null} />);
  expect(within(view.container).getByLabelText('Gateway ID')).toBeTruthy();
  expect(within(view.container).getByText('No saved items yet.')).toBeTruthy();
});
