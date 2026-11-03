import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Agent } from '../../app/types';
import { UnsavedChangesProvider, useUnsavedChanges } from '../../app/UnsavedChanges';
import { AgentToolbar, type AgentToolbarProps } from './AgentToolbar';
import css from './agentToolbarPicker.css?raw';
import postcss from 'postcss';

const agents = Array.from(
  { length: 17 },
  (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, enabled: i !== 16 }) as Agent,
);
const props = (overrides: Partial<AgentToolbarProps> = {}): AgentToolbarProps => ({
  agents,
  selectedId: 'agent-0',
  onSelect: vi.fn(),
  onSelectGlobal: vi.fn(),
  onAgentsChanged: async () => {},
  onModelConnectionsChanged: async () => {},
  ...overrides,
});
const strip = () => screen.getByRole('group', { name: 'Agent buttons' });
const agentButton = (index: number) =>
  screen.getByRole('button', { name: `Agent ${index}` }) as HTMLButtonElement;
const leftArrow = () =>
  screen.getByRole('button', { name: 'Scroll agents left' }) as HTMLButtonElement;
const rightArrow = () =>
  screen.getByRole('button', { name: 'Scroll agents right' }) as HTMLButtonElement;

// JSDOM does not lay out or scroll. Model the real relationship between the
// available shell, arrow-reduced viewport, and nonwrapping agent content.
let shellWidth = 2400;
let buttonWidth = 100;
let buttonWidths: number[] | undefined;
const observers = new Set<{
  callback: ResizeObserverCallback;
  instance: ResizeObserver;
  targets: Set<Element>;
}>();
const isStrip = (element: Element) => element.getAttribute('aria-label') === 'Agent buttons';
const isShell = (element: Element) =>
  Boolean(element.querySelector(':scope > [aria-label="Agent buttons"]'));
function intrinsicButtonWidth(element: Element) {
  const parent = element.parentElement;
  if (element.tagName !== 'BUTTON' || !parent || !isStrip(parent)) return 0;
  const index = [...parent.querySelectorAll('button')].indexOf(element as HTMLButtonElement);
  return buttonWidths?.[index] ?? buttonWidth;
}
function viewportWidth(element: Element) {
  const hasArrows = element.parentElement?.querySelector(
    '[aria-label="Scroll agents left"]:not([hidden])',
  );
  return Math.max(1, shellWidth - (hasArrows ? 72 : 0));
}
function renderedWidths(element: Element) {
  return [...element.querySelectorAll('button')].map((_, index) =>
    Math.min(buttonWidths?.[index] ?? buttonWidth, viewportWidth(element)),
  );
}
function contentWidth(element: Element) {
  const widths = renderedWidths(element);
  return widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * 7;
}
function rectangle(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 34,
    width,
    height: 34,
    toJSON: () => ({}),
  };
}
function resize(width: number) {
  shellWidth = width;
  act(() => {
    for (const observer of observers)
      observer.callback(
        [...observer.targets].map((target) => ({
          target,
          contentRect: target.getBoundingClientRect(),
        })) as ResizeObserverEntry[],
        observer.instance,
      );
  });
}
function expectVisible(button: HTMLElement) {
  const viewport = strip().getBoundingClientRect();
  const bounds = button.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1);
  expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1);
}

beforeEach(() => {
  shellWidth = 2400;
  buttonWidth = 100;
  buttonWidths = undefined;
  observers.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: ResizeObserverCallback; instance: ResizeObserver; targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, instance: this as unknown as ResizeObserver, targets: new Set() };
        observers.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        observers.delete(this.entry);
      }
    },
  );
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo);
    if (isStrip(element))
      Object.defineProperty(style, 'columnGap', { configurable: true, value: '7px' });
    return style;
  });
  const offsets = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockImplementation(function (this: Element) {
    return Math.max(0, Math.min(offsets.get(this) ?? 0, contentWidth(this) - viewportWidth(this)));
  });
  vi.spyOn(Element.prototype, 'scrollLeft', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    offsets.set(this, value);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (isStrip(this)) return viewportWidth(this);
    if (isShell(this)) return shellWidth;
    return Math.min(
      intrinsicButtonWidth(this),
      this.parentElement ? viewportWidth(this.parentElement) : 0,
    );
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return isStrip(this)
      ? Math.max(viewportWidth(this), contentWidth(this))
      : intrinsicButtonWidth(this);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (isStrip(this)) return rectangle(0, viewportWidth(this));
    if (isShell(this)) return rectangle(0, shellWidth);
    const parent = this.parentElement;
    if (this.tagName === 'BUTTON' && parent && isStrip(parent)) {
      const index = [...parent.querySelectorAll('button')].indexOf(this as HTMLButtonElement);
      const widths = renderedWidths(parent);
      const left = widths.slice(0, index).reduce((total, width) => total + width + 7, 0);
      return rectangle(left - parent.scrollLeft, widths[index]);
    }
    return rectangle(0, 0);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([1, 8, 9, 17])(
  'keeps %i agents as buttons with no dropdown, even across the old threshold',
  (count) => {
    render(<AgentToolbar {...props({ agents: agents.slice(0, count) })} />);
    expect(within(strip()).getAllByRole('button')).toHaveLength(count);
    for (let index = 0; index < count; index++) {
      const button = agentButton(index);
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBe(0);
      expect(button.getAttribute('aria-pressed')).toBe(String(index === 0));
    }
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll agents left' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
    expect(strip().contains(screen.getByRole('button', { name: 'Global' }))).toBe(false);
    expect(strip().contains(screen.getByRole('button', { name: 'New Agent' }))).toBe(false);
  },
);

it.each([8, 9, 17])(
  'shows scroll controls for %i agents only when their actual widths overflow',
  (count) => {
    shellWidth = 350;
    render(<AgentToolbar {...props({ agents: agents.slice(0, count) })} />);
    resize(shellWidth);
    expect(leftArrow().disabled).toBe(true);
    expect(rightArrow().disabled).toBe(false);
    expect(within(strip()).getAllByRole('button')).toHaveLength(count);
    expect(screen.queryByRole('combobox')).toBeNull();
  },
);

it('scrolls in both directions, disables controls at the ends, and never changes selection', () => {
  shellWidth = 400;
  const toolbarProps = props();
  render(<AgentToolbar {...toolbarProps} />);
  expect(leftArrow().disabled).toBe(true);
  fireEvent.click(rightArrow());
  fireEvent.scroll(strip());
  expect(strip().scrollLeft).toBeGreaterThan(0);
  expect(leftArrow().disabled).toBe(false);
  const forward = strip().scrollLeft;
  fireEvent.click(leftArrow());
  fireEvent.scroll(strip());
  expect(strip().scrollLeft).toBeLessThan(forward);
  expect(leftArrow().disabled).toBe(true);
  for (let page = 0; page < 20 && !rightArrow().disabled; page++) {
    fireEvent.click(rightArrow());
    fireEvent.scroll(strip());
  }
  expect(rightArrow().disabled).toBe(true);
  expectVisible(agentButton(16));
  expect(toolbarProps.onSelect).not.toHaveBeenCalled();
  expect(agentButton(0).getAttribute('aria-pressed')).toBe('true');
});

it('removes arrows when resized content fits the full shell, not the arrow-reduced viewport', () => {
  shellWidth = 350;
  render(<AgentToolbar {...props({ agents: agents.slice(0, 4) })} />);
  expect(rightArrow()).toBeTruthy();
  // 421px content fits 450px, but would not fit 378px with arrows still present.
  resize(450);
  expect(screen.queryByRole('button', { name: 'Scroll agents left' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
  resize(300);
  expect(leftArrow().disabled).toBe(true);
  expect(rightArrow().disabled).toBe(false);
  resize(2400);
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
});

it('reveals an initially selected or newly selected agent and keeps it visible after a resize', () => {
  shellWidth = 400;
  const toolbarProps = props({ selectedId: 'agent-16' });
  const view = render(<AgentToolbar {...toolbarProps} />);
  resize(shellWidth);
  expectVisible(agentButton(16));
  expect(strip().scrollLeft).toBeGreaterThan(0);
  view.rerender(<AgentToolbar {...toolbarProps} selectedId="agent-0" />);
  expectVisible(agentButton(0));
  expect(strip().scrollLeft).toBe(0);
  view.rerender(<AgentToolbar {...toolbarProps} selectedId="agent-9" />);
  expectVisible(agentButton(9));
  resize(250);
  expectVisible(agentButton(9));
  expect(toolbarProps.onSelect).not.toHaveBeenCalled();
});

it('preserves the selected button when the catalog crosses eight agents in either direction', () => {
  const toolbarProps = props({ selectedId: 'agent-7' });
  const view = render(<AgentToolbar {...toolbarProps} agents={agents.slice(0, 8)} />);
  for (const count of [9, 17, 8]) {
    view.rerender(<AgentToolbar {...toolbarProps} agents={agents.slice(0, count)} />);
    expect(within(strip()).getAllByRole('button')).toHaveLength(count);
    expect(agentButton(7).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('combobox')).toBeNull();
  }
  expect(toolbarProps.onSelect).not.toHaveBeenCalled();
});

it('moves keyboard focus with Arrow keys, Home and End without selecting or losing visibility', () => {
  shellWidth = 400;
  const toolbarProps = props();
  render(<AgentToolbar {...toolbarProps} />);
  act(() => agentButton(0).focus());
  fireEvent.keyDown(agentButton(0), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(agentButton(1));
  fireEvent.keyDown(agentButton(1), { key: 'End' });
  expect(document.activeElement).toBe(agentButton(16));
  expectVisible(agentButton(16));
  fireEvent.keyDown(agentButton(16), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(agentButton(16));
  fireEvent.keyDown(agentButton(16), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(agentButton(15));
  fireEvent.keyDown(agentButton(15), { key: 'Home' });
  expect(document.activeElement).toBe(agentButton(0));
  expectVisible(agentButton(0));
  fireEvent.keyDown(agentButton(0), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(agentButton(0));
  expect(toolbarProps.onSelect).not.toHaveBeenCalled();
  expect(agentButton(0).getAttribute('aria-pressed')).toBe('true');
  // Native buttons retain Enter/Space activation. A click is the native
  // activation event; JSDOM does not synthesize it from keyboard events.
  fireEvent.click(agentButton(15), { detail: 0 });
  expect(toolbarProps.onSelect).toHaveBeenCalledWith('agent-15');
});

it('keeps disabled agents manageable and guards selection with Stay and Discard', () => {
  shellWidth = 400;
  const onSelect = vi.fn();
  function Subject() {
    const [selectedId, setSelectedId] = useState('agent-0');
    const [dirty, setDirty] = useState(true);
    useUnsavedChanges({
      dirty,
      busy: false,
      save: async () => true,
      discard: () => setDirty(false),
    });
    return (
      <AgentToolbar
        {...props({
          selectedId,
          onSelect: (id) => {
            onSelect(id);
            setSelectedId(id);
          },
        })}
      />
    );
  }
  render(
    <UnsavedChangesProvider>
      <Subject />
    </UnsavedChangesProvider>,
  );
  expect(agentButton(16).disabled).toBe(false);
  expect(agentButton(16).classList.contains('agent-disabled')).toBe(true);
  act(() => agentButton(0).focus());
  fireEvent.keyDown(agentButton(0), { key: 'End' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(agentButton(16), { detail: 0 });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(agentButton(0).getAttribute('aria-pressed')).toBe('true');
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(agentButton(16));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('agent-16');
  expect(agentButton(16).getAttribute('aria-pressed')).toBe('true');
  expectVisible(agentButton(16));
});

it('preserves Global and New Agent navigation guards while scrolling remains safe', () => {
  shellWidth = 400;
  const onSelectGlobal = vi.fn();
  function Subject() {
    useUnsavedChanges({ dirty: true, busy: false, save: async () => true, discard: vi.fn() });
    return <AgentToolbar {...props({ onSelectGlobal })} />;
  }
  render(
    <UnsavedChangesProvider>
      <Subject />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(rightArrow());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Global' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(onSelectGlobal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'New Agent' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps Global selection distinct and allows returning to the same agent', () => {
  const toolbarProps = props({ globalSelected: true, selectedId: 'agent-16' });
  render(<AgentToolbar {...toolbarProps} />);
  expect(screen.getByRole('button', { name: 'Global' }).getAttribute('aria-pressed')).toBe('true');
  for (const button of within(strip()).getAllByRole('button'))
    expect(button.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Global' }));
  expect(toolbarProps.onSelectGlobal).not.toHaveBeenCalled();
  fireEvent.click(agentButton(16));
  expect(toolbarProps.onSelect).toHaveBeenCalledExactlyOnceWith('agent-16');
});

it('disconnects layout observers when the toolbar unmounts', () => {
  const view = render(<AgentToolbar {...props()} />);
  expect(observers.size).toBeGreaterThan(0);
  view.unmount();
  expect(observers.size).toBe(0);
});

// CSS is part of the interaction contract: JSDOM geometry mocks alone cannot
// detect a return to wrapped rows, shrinking buttons, or a mobile column.
it('enforces one horizontal row and nonshrinking agent buttons in the stylesheet', () => {
  const root = postcss.parse(css);
  const declarations = (selector: string) => {
    const values = new Map<string, string>();
    root.walkRules(selector, (rule) => {
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    });
    return values;
  };
  const toolbar = declarations('.agent-toolbar.agent-toolbar-buttons');
  expect(toolbar.get('flex-direction')).toBe('row');
  expect(toolbar.get('flex-wrap')).toBe('nowrap');
  expect(declarations('.agent-toolbar-buttons .agent-toolbar-selector').get('flex-wrap')).toBe(
    'nowrap',
  );
  const row = declarations('.agent-toolbar-agent-list');
  expect(row.get('display')).toBe('flex');
  expect(row.get('flex-wrap')).toBe('nowrap');
  expect(row.get('overflow-x')).toBe('auto');
  const button = declarations('.agent-toolbar-agent-list > button');
  expect(button.get('flex')).toBe('0 0 auto');
  expect(button.get('white-space')).toBe('nowrap');
  expect(button.get('max-width')).toBe('100%');
  expect(declarations('.agent-toolbar-buttons .agent-toolbar-arrow[hidden]').get('display')).toBe(
    'none',
  );
});

it('keeps a single long agent name in the narrow row without unnecessary arrows', () => {
  shellWidth = 150;
  buttonWidth = 300;
  render(<AgentToolbar {...props({ agents: agents.slice(0, 1) })} />);
  expect(screen.queryByRole('button', { name: 'Scroll agents left' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
  expectVisible(agentButton(0));
});

it('does not leave the current agent after a failed guard Save and permits a successful retry', async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const onSelect = vi.fn();
  function Subject() {
    const [selectedId, setSelectedId] = useState('agent-0');
    useUnsavedChanges({ dirty: true, busy: false, save, discard: vi.fn() });
    return (
      <AgentToolbar
        {...props({
          selectedId,
          onSelect: (id) => {
            onSelect(id);
            setSelectedId(id);
          },
        })}
      />
    );
  }
  render(
    <UnsavedChangesProvider>
      <Subject />
    </UnsavedChangesProvider>,
  );
  fireEvent.click(agentButton(16));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(onSelect).not.toHaveBeenCalled();
  expect(agentButton(0).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(agentButton(16));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(save).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('agent-16');
  expect(agentButton(16).getAttribute('aria-pressed')).toBe('true');
});

it('rechecks actual overflow after an agent is renamed', () => {
  shellWidth = 450;
  const toolbarProps = props({ agents: agents.slice(0, 4) });
  const view = render(<AgentToolbar {...toolbarProps} />);
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
  buttonWidth = 160;
  view.rerender(
    <AgentToolbar
      {...toolbarProps}
      agents={toolbarProps.agents.map((agent) => ({
        ...agent,
        name: `${agent.name} with a longer name`,
      }))}
    />,
  );
  expect(rightArrow()).toBeTruthy();
  buttonWidth = 100;
  view.rerender(<AgentToolbar {...toolbarProps} />);
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
});

it('updates overflow on window resize when ResizeObserver is unavailable', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  render(<AgentToolbar {...props()} />);
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
  shellWidth = 400;
  fireEvent(window, new Event('resize'));
  expect(rightArrow()).toBeTruthy();
  shellWidth = 2400;
  fireEvent(window, new Event('resize'));
  expect(screen.queryByRole('button', { name: 'Scroll agents right' })).toBeNull();
});

it('keeps overflow controls stable for a viewport-wide name beside a short name', () => {
  shellWidth = 400;
  buttonWidths = [900, 50];
  render(<AgentToolbar {...props({ agents: agents.slice(0, 2) })} />);
  // Capping the first label to the arrow-reduced viewport must not make the
  // measured content seem to fit the full shell and hide the controls again.
  for (let notification = 0; notification < 4; notification++) {
    resize(shellWidth);
    expect(rightArrow()).toBeTruthy();
  }
  fireEvent.click(rightArrow());
  fireEvent.scroll(strip());
  expectVisible(agentButton(1));
});

it('reserves the collapsed statistics opener space without narrowing the open dock toolbar', () => {
  const reservations: postcss.Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    rule.walkDecls('padding-right', (declaration) => {
      if (declaration.value === '44px') reservations.push(rule);
    });
  });
  expect(reservations).toHaveLength(1);
  const reservation = reservations[0];
  expect(reservation.selector.replace(/\s+/g, ' ').trim()).toBe(
    '.settings-fidgit.has-agent-selector:not(.has-utility-panel) > .settings-prototype-agent-selector .agent-toolbar-buttons',
  );
  // The reservation also protects narrow screens; it is not desktop-only.
  expect(reservation.parent?.type).toBe('root');
  const view = render(
    <div className="settings-fidgit has-agent-selector" data-testid="settings-workspace">
      <div className="settings-prototype-agent-selector">
        <AgentToolbar {...props()} />
      </div>
    </div>,
  );
  const workspace = screen.getByTestId('settings-workspace');
  const toolbar = screen.getByLabelText('Agent configuration selector');
  expect(toolbar.matches(reservation.selector)).toBe(true);
  workspace.classList.add('has-utility-panel');
  expect(toolbar.matches(reservation.selector)).toBe(false);
  workspace.classList.remove('has-utility-panel');
  expect(toolbar.matches(reservation.selector)).toBe(true);
  workspace.classList.remove('has-agent-selector');
  expect(toolbar.matches(reservation.selector)).toBe(false);
  view.rerender(<AgentToolbar {...props()} />);
  expect(screen.getByLabelText('Agent configuration selector').matches(reservation.selector)).toBe(
    false,
  );
});
