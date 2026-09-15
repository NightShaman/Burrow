import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RailPanelSettings } from './RailPanelSettings';
afterEach(cleanup);
const props = { side: 'Left' as const, singlePanel: 'agents' as const, topPanel: 'agents' as const, bottomPanel: 'workspace' as const, setLayout: vi.fn(), setSinglePanel: vi.fn(), setTopPanel: vi.fn(), setBottomPanel: vi.fn() };
it('offers two layout choices and only one panel selector in single mode', () => {
 render(<RailPanelSettings {...props} layout="single" />);
 expect(screen.getAllByRole('combobox')).toHaveLength(2);
 expect(screen.queryByText('Left · top')).toBeNull();
 expect(screen.queryByText('Left · bottom')).toBeNull();
 expect(screen.getByRole('option', { name: '1 panel' })).toBeTruthy();
 fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'workspace' } });
 expect(props.setSinglePanel).toHaveBeenCalledWith('workspace');
 expect(props.setTopPanel).not.toHaveBeenCalled();
 expect(props.setBottomPanel).not.toHaveBeenCalled();
});
it('shows top and bottom selectors only in divided mode', () => {
 render(<RailPanelSettings {...props} layout="divided" />);
 expect(screen.getAllByRole('combobox')).toHaveLength(3);
 expect(screen.getByText('Left · top')).toBeTruthy();
 expect(screen.getByText('Left · bottom')).toBeTruthy();
});
