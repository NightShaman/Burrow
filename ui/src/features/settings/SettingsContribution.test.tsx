import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeclarativeSection } from './ModSettingsHost';
import { validateSettingsContribution } from './SettingsContribution';

describe('settings contribution list-detail items', () => {
  const assignments = {
    sections: [{
      id: 'assignments',
      label: 'Agent assignments',
      description: 'Choose where each agent executes future turns.',
      layout: 'list-detail',
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

  it('renders the assignment list in primary and selected detail in overflow', () => {
    const contribution = validateSettingsContribution(assignments);
    expect(contribution).not.toBeNull();
    const overflow = document.createElement('div');
    render(<DeclarativeSection contribution={contribution!} section={contribution!.sections[0]} module={{}} overflowTarget={overflow} />);

    expect(within(document.body).getByRole('button', { name: /Smatchet/ })).toBeTruthy();
    expect(within(overflow).getByRole('heading', { name: 'Smatchet' })).toBeTruthy();
    expect(within(overflow).getByText('Assignments apply to future turns only.')).toBeTruthy();
    expect(within(overflow).getByRole('button', { name: 'Save assignment' })).toBeTruthy();
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
