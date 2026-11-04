import './agentToolbarPicker.css';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type SettingsEntityItem = {
  id: string;
  label: string;
  disabled?: boolean;
};
/** The native Agent selector shared with owner-managed Settings editors. */
export function SettingsEntitySelector({
  items,
  selectedId,
  onSelect,
  label,
  noun,
  action,
  leading,
  unselected = false,
  groupLabel = label,
  buttonsLabel = `${label} buttons`,
}: {
  items: readonly SettingsEntityItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  label: string;
  groupLabel?: string;
  buttonsLabel?: string;
  noun: string;
  action?: ReactNode;
  leading?: ReactNode;
  unselected?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const itemLayoutKey = JSON.stringify(items.map((item) => [item.id, item.label]));
  const [scroll, setScroll] = useState({
    overflow: false,
    left: false,
    right: false,
  });
  const measure = useCallback(() => {
    const list = listRef.current,
      shell = scrollRef.current;
    if (!list || !shell) return;
    // Compare against the space before arrows are allocated, so arrows cannot
    // create their own permanent overflow when the workspace grows again.
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-agent-id]'));
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    // Long names are clipped to the viewport. Recover their intrinsic width
    // before asking whether they would fit with the arrows removed.
    const contentWidth =
      buttons.reduce(
        (sum, button) =>
          sum +
          Math.min(
            shell.clientWidth,
            button.getBoundingClientRect().width +
              Math.max(0, button.scrollWidth - button.clientWidth),
          ),
        0,
      ) +
      gap * Math.max(0, buttons.length - 1);
    const next = {
      overflow: contentWidth > shell.clientWidth + 1,
      left: list.scrollLeft > 1,
      right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
    };
    setScroll((previous) =>
      previous.overflow === next.overflow &&
      previous.left === next.left &&
      previous.right === next.right
        ? previous
        : next,
    );
  }, []);
  const reveal = useCallback(
    (button: HTMLElement | null) => {
      const list = listRef.current;
      if (!button || !list) return;
      const item = button.getBoundingClientRect(),
        viewport = list.getBoundingClientRect();
      if (item.left < viewport.left) list.scrollLeft += item.left - viewport.left;
      else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right;
      measure();
    },
    [measure],
  );
  useLayoutEffect(() => {
    const refresh = () => {
      measure();
      if (!unselected)
        reveal(listRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? null);
    };
    refresh();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    if (scrollRef.current) observer?.observe(scrollRef.current);
    if (listRef.current) observer?.observe(listRef.current);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, [itemLayoutKey, selectedId, unselected, measure, reveal]);
  const scrollAgents = (direction: number) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollLeft += direction * Math.max(80, list.clientWidth * 0.8);
    measure();
  };
  return (
    <div className="agent-toolbar agent-toolbar-buttons" aria-label={label}>
      {action}
      <div className="agent-toolbar-selector" role="group" aria-label={groupLabel}>
        {leading}
        <div className="agent-toolbar-scroll" ref={scrollRef}>
          <button
            type="button"
            className="agent-toolbar-arrow"
            aria-label={`Scroll ${noun} left`}
            aria-controls={listId}
            hidden={!scroll.overflow}
            disabled={!scroll.left}
            onClick={() => scrollAgents(-1)}
          >
            ‹
          </button>
          <div
            className="agent-toolbar-agent-list"
            id={listId}
            ref={listRef}
            role="group"
            aria-label={buttonsLabel}
            onScroll={measure}
            onKeyDown={(event) => {
              const buttons = Array.from(
                listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-agent-id]') ?? [],
              );
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              const next =
                event.key === 'ArrowRight'
                  ? Math.min(index + 1, buttons.length - 1)
                  : event.key === 'ArrowLeft'
                    ? Math.max(index - 1, 0)
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              buttons[next]?.focus();
              reveal(buttons[next] ?? null);
            }}
          >
            {items.map((item) => (
              <button
                className={[
                  !unselected && item.id === selectedId ? 'active' : '',
                  item.disabled ? 'agent-disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                key={item.id}
                data-agent-id={item.id}
                title={item.label}
                aria-pressed={!unselected && item.id === selectedId}
                onFocus={(event) => reveal(event.currentTarget)}
                onClick={() => {
                  if (unselected || item.id !== selectedId) onSelect(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="agent-toolbar-arrow"
            aria-label={`Scroll ${noun} right`}
            aria-controls={listId}
            hidden={!scroll.overflow}
            disabled={!scroll.right}
            onClick={() => scrollAgents(1)}
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
