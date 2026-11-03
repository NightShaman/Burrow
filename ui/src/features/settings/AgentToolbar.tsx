import './agentToolbarPicker.css';
import { useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { isAgentEnabled } from '../../app/agentCatalog';
import { FirstRunSetup } from './FirstRunSetup';
import { NewAgentDialog } from './NewAgentDialog';

export type AgentToolbarProps = {
  agents: Agent[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAgentsChanged: () => Promise<void>;
  onModelConnectionsChanged: () => Promise<void>;
  onOperatorProfileChanged?: (profile: { name: string; avatar: string }) => void;
  onFirstRunComplete?: () => void;
  onSetupComplete?: () => Promise<void>;
  firstRun?: boolean;
  globalSelected?: boolean;
  onSelectGlobal?: () => void;
};

/** Setup state is explicit; an empty registry is not a first-run signal. */
export function AgentToolbar(props: AgentToolbarProps) {
  const { agents, selectedId, onSelect, firstRun = false } = props;
  const navigate = useUnsavedNavigation();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const agentLayoutKey = JSON.stringify(agents.map((agent) => [agent.id, agent.name]));
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });
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
      if (!props.globalSelected)
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
  }, [agentLayoutKey, selectedId, props.globalSelected, measure, reveal]);
  const scrollAgents = (direction: number) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollLeft += direction * Math.max(80, list.clientWidth * 0.8);
    measure();
  };
  // Setup status becomes ready before the existing five-second finale ends.
  // Retain that owner until its completion callback, not merely while status is fresh.
  const [setupOpen, setSetupOpen] = useState(firstRun);
  useEffect(() => {
    if (firstRun) setSetupOpen(true);
  }, [firstRun]);
  return (
    <>
      <div
        className="agent-toolbar agent-toolbar-buttons"
        aria-label="Agent configuration selector"
      >
        <button
          className="primary"
          type="button"
          onClick={() => navigate(() => setShowNewAgent(true))}
        >
          New Agent
        </button>
        <div className="agent-toolbar-selector" role="group" aria-label="Configured agents">
          {props.onSelectGlobal && (
            <button
              type="button"
              className={props.globalSelected ? 'active' : ''}
              aria-pressed={props.globalSelected === true}
              onClick={() => {
                if (!props.globalSelected) navigate(props.onSelectGlobal!);
              }}
            >
              Global
            </button>
          )}
          <div className="agent-toolbar-scroll" ref={scrollRef}>
            <button
              type="button"
              className="agent-toolbar-arrow"
              aria-label="Scroll agents left"
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
              aria-label="Agent buttons"
              onScroll={measure}
              onKeyDown={(event) => {
                const buttons = Array.from(
                  listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-agent-id]') ??
                    [],
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
              {agents.map((agent) => (
                <button
                  className={[
                    !props.globalSelected && agent.id === selectedId ? 'active' : '',
                    !isAgentEnabled(agent) ? 'agent-disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  key={agent.id}
                  data-agent-id={agent.id}
                  title={agent.name}
                  aria-pressed={!props.globalSelected && agent.id === selectedId}
                  onFocus={(event) => reveal(event.currentTarget)}
                  onClick={() => {
                    if (props.globalSelected || agent.id !== selectedId)
                      navigate(() => onSelect(agent.id));
                  }}
                >
                  {agent.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="agent-toolbar-arrow"
              aria-label="Scroll agents right"
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
      {setupOpen ? (
        <FirstRunSetup
          {...props}
          onFirstRunComplete={() => {
            setSetupOpen(false);
            props.onFirstRunComplete?.();
          }}
        />
      ) : showNewAgent ? (
        <NewAgentDialog
          onClose={() => setShowNewAgent(false)}
          onSelect={onSelect}
          onAgentsChanged={props.onAgentsChanged}
        />
      ) : null}
    </>
  );
}
