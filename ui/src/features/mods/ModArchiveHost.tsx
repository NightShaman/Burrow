import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiLocal as api } from '../../app/api';
import type { ModArchive } from '../../app/modPanels';

type HeaderOption = { id: string; label: string };
export type ArchiveHeader = {
  searchPlaceholder?: string;
  searchMaxLength?: number;
  participantLabel?: string;
  participants: HeaderOption[];
  participantsStatus?: string;
  participantsDisabled?: boolean;
  categories: HeaderOption[];
};
type ArchiveFilters = { search: string; participantId: string; category: string };
const emptyFilters = (): ArchiveFilters => ({ search: '', participantId: '', category: '' });
type ArchiveContext = {
  filters: ArchiveFilters;
  configureHeader?: (header: ArchiveHeader) => void;
  date: string;
  timeZone: string;
  modId: string;
  runtimeScope: 'local';
  root: HTMLElement;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
};
type Cleanup =
  | void
  | (() => void)
  | { unmount?: () => void; update?: (context: ArchiveContext) => void };
type ArchiveModule = { mountArchive?: (context: ArchiveContext) => Cleanup | Promise<Cleanup> };

export function ModArchiveHost({
  panel,
  date,
  headerRoot,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
}: {
  headerRoot?: HTMLElement | null;
  panel: ModArchive;
  date: string;
  timeZone?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [header, setHeader] = useState<ArchiveHeader | null>(null);
  const [filters, setFilters] = useState<ArchiveFilters>(emptyFilters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const dateRef = useRef(date);
  dateRef.current = date;
  const timeZoneRef = useRef(timeZone);
  timeZoneRef.current = timeZone;
  const updateRef = useRef<(() => void) | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const filterOwnerRef = useRef('');
  useEffect(() => {
    let disposed = false;
    setHeader(null);
    const filterOwner = JSON.stringify([panel.modId, panel.archiveUrl, panel.version]);
    if (filterOwnerRef.current !== filterOwner) {
      filterOwnerRef.current = filterOwner;
      filtersRef.current = emptyFilters();
      setFilters(filtersRef.current);
    }
    let cleanup: (() => void) | undefined;
    const host = root.current;
    if (!host) return;
    // A late async mount must never clear a newer mount's DOM.
    const node = document.createElement('div');
    host.replaceChildren(node);
    const timer = window.setTimeout(() => {
      if (!disposed) {
        disposed = true;
        node.remove();
        setLoading(false);
        setHeader(null);
        setError('The mod panel took too long to load.');
      }
    }, 15000);
    setError('');
    setLoading(true);
    const url = panel.archiveUrl + (panel.version ? `?v=${encodeURIComponent(panel.version)}` : '');
    void import(/* @vite-ignore */ url)
      .then(async (module: ArchiveModule) => {
        if (disposed) return;
        if (typeof module.mountArchive !== 'function')
          throw new Error('The mod does not export mountArchive.');
        const context: ArchiveContext = {
          filters: { ...filtersRef.current },
          ...(headerRoot
            ? {
                configureHeader: (value: ArchiveHeader) => {
                  if (disposed) return;
                  // Copy data: a mod cannot mutate rendered host controls after registration.
                  const next = {
                    ...value,
                    categories: value.categories.map((option) => ({ ...option })),
                    participants: value.participants.map((option) => ({ ...option })),
                  };
                  setHeader(next);
                  setFilters((current) => ({
                    ...current,
                    category: next.categories.some((option) => option.id === current.category)
                      ? current.category
                      : next.categories[0]?.id || '',
                    participantId:
                      next.participantsDisabled ||
                      next.participants.some((option) => option.id === current.participantId)
                        ? current.participantId
                        : '',
                  }));
                },
              }
            : {}),
          date: dateRef.current,
          timeZone: timeZoneRef.current,
          modId: panel.modId,
          runtimeScope: 'local',
          root: node,
          api: <T,>(path: string, init?: RequestInit) => {
            const normalized = path.startsWith('/') ? path : `/${path}`;
            const pathname = normalized.split('?')[0];
            if (
              pathname.includes('..') ||
              normalized.includes('#') ||
              pathname.includes('\\') ||
              /%2e|%2f|%5c/i.test(pathname)
            )
              return Promise.reject(new Error('Invalid mod API path.'));
            return api<T>(`/api/mods/${panel.modId}${normalized}`, init);
          },
        };
        const result = await module.mountArchive(context);
        const dispose = typeof result === 'function' ? result : result ? result.unmount : undefined;
        if (disposed) {
          try {
            dispose?.();
          } catch {
            /* Isolate late cleanup. */
          } finally {
            node.remove();
            node.replaceChildren();
          }
        } else {
          cleanup = dispose;
          updateRef.current = () => {
            if (
              disposed ||
              (context.date === dateRef.current &&
                context.timeZone === timeZoneRef.current &&
                context.filters.search === filtersRef.current.search &&
                context.filters.participantId === filtersRef.current.participantId &&
                context.filters.category === filtersRef.current.category)
            )
              return;
            context.filters = { ...filtersRef.current };
            context.date = dateRef.current;
            context.timeZone = timeZoneRef.current;
            if (result && typeof result !== 'function' && result.update) {
              try {
                result.update({ ...context });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not update mod panel.');
              }
            } else setRevision((value) => value + 1); // Legacy mounts still receive fresh date context.
          };
          window.clearTimeout(timer);
          setLoading(false);
          updateRef.current(); // Catch date changes while import/mount was pending.
        }
      })
      .catch((cause) => {
        if (!disposed) {
          disposed = true;
          window.clearTimeout(timer);
          setLoading(false);
          node.replaceChildren();
          setHeader(null);
          setError(cause instanceof Error ? cause.message : 'Could not load mod panel.');
        }
      });
    return () => {
      disposed = true;
      updateRef.current = undefined;
      window.clearTimeout(timer);
      node.remove();
      try {
        cleanup?.();
      } catch {
        /* A mod cleanup must not break Archive navigation. */
      } finally {
        node.replaceChildren();
      }
    };
  }, [panel.modId, panel.archiveUrl, panel.version, revision, headerRoot]);
  useEffect(() => {
    updateRef.current?.();
  }, [date, timeZone, filters]);
  return (
    <div
      className={`page-view mod-panel-page${header ? ' archive-mod-integrated' : ''}`}
      data-mod-id={panel.modId}
    >
      {header &&
        headerRoot &&
        createPortal(
          <>
            <div className="archive-mod-categories" role="group" aria-label="Archive category">
              {header.categories.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={filters.category === option.id}
                  onClick={() => setFilters((current) => ({ ...current, category: option.id }))}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <label className="archive-search">
              <span className="sr-only">Search archive</span>
              <input
                type="search"
                maxLength={header.searchMaxLength}
                value={filters.search}
                placeholder={header.searchPlaceholder || 'Search archive'}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, search: event.target.value }))
                }
              />
            </label>
            <label className="archive-agent-filter">
              <span className="sr-only">{header.participantLabel || 'Participant'}</span>
              <select
                value={filters.participantId}
                disabled={header.participantsDisabled}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, participantId: event.target.value }))
                }
              >
                <option value="">All participants</option>
                {header.participants.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {header.participantsStatus && (
              <span className="archive-mod-header-status" role="status">
                {header.participantsStatus}
              </span>
            )}
          </>,
          headerRoot,
        )}
      {loading && !error && <p role="status">Loading {panel.name}…</p>}
      {error && (
        <section className="setting-section">
          <h2>{panel.name} unavailable</h2>
          <p role="alert">{error}</p>
        </section>
      )}
      <div ref={root} className={header ? 'archive-mod-mount' : undefined} />
    </div>
  );
}
