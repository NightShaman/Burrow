import { useEffect, useState, type ReactNode } from 'react';
import { useConfirm } from '../../app/ConfirmDialog';
import { AccessibleModal } from '../../app/AccessibleModal';
import './forgeGallery.css';
import { useOwnedApi } from '../../app/useOwnedApi';

type Artifact = {
  id: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
  downloadUrl: string;
};
type Picture = { id: string; name: string; media: ReactNode; jobId: string; artifactId: string };
type Folder = { id: string; name: string; parent: string | null };
type Catalog = {
  folders: { id: string; name: string; parentId: string | null }[];
  images: { jobId: string; artifactId: string; folderId: string | null; artifact: Artifact }[];
};
export function ForgeGallery({
  renderArtifact,
}: {
  renderArtifact: (artifact: Artifact, jobId: string) => ReactNode;
}) {
  const owned = useOwnedApi();
  const confirm = useConfirm();
  const [catalog, setCatalog] = useState<Catalog>({ folders: [], images: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    owned
      .api<Catalog>('/api/forge/gallery')
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {
        if (active) setError('Could not load the gallery.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [owned, attempt]);
  const folders: Folder[] = catalog.folders.map((folder) => ({
    ...folder,
    parent: folder.parentId,
  }));
  const galleryPictures: Picture[] = catalog.images.map((image) => ({
    id: `${image.jobId}:${image.artifactId}`,
    name: image.artifact.name,
    jobId: image.jobId,
    artifactId: image.artifactId,
    media: renderArtifact(image.artifact, image.jobId),
  }));
  const placements = Object.fromEntries(
    catalog.images.map((image) => [`${image.jobId}:${image.artifactId}`, image.folderId]),
  );
  const [current, setCurrent] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [moving, setMoving] = useState<Picture[] | null>(null);
  const [batchMove, setBatchMove] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = (folderId: string | null) => {
    if (busy) return;
    setCurrent(folderId);
    setSelected([]);
  };
  const [destination, setDestination] = useState('');
  const ancestors: Folder[] = [];
  let cursor = current;
  while (cursor) {
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    ancestors.unshift(folder);
    cursor = folder.parent;
  }
  const visible = galleryPictures.filter((picture) => (placements[picture.id] ?? null) === current);
  const children = folders.filter((folder) => folder.parent === current);
  const path = (folder: Folder): string => {
    const labels = [folder.name];
    let parent = folders.find((item) => item.id === folder.parent);
    while (parent) {
      labels.unshift(parent.name);
      parent = folders.find((item) => item.id === parent!.parent);
    }
    return labels.join(' / ');
  };
  return (
    <section className="forge-gallery" aria-label="Media gallery">
      <header className="forge-gallery-toolbar">
        <nav aria-label="Gallery folders">
          <button
            onClick={() => navigate(null)}
            aria-current={current === null ? 'page' : undefined}
          >
            Gallery
          </button>
          {ancestors.map((folder) => (
            <span key={folder.id}>
              <span aria-hidden="true"> / </span>
              <button
                onClick={() => navigate(folder.id)}
                aria-current={folder.id === current ? 'page' : undefined}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
        <button
          disabled={loading || busy || !!error}
          onClick={() => {
            setName('');
            setCreating(true);
          }}
        >
          ＋ New folder
        </button>
      </header>
      <div className="forge-gallery-selection" aria-label="Gallery selection">
        <span role="status">{selected.length} selected</span>
        <button
          disabled={loading || busy || !selected.length}
          onClick={() => {
            setMoving(visible.filter((picture) => selected.includes(picture.id)));
            setBatchMove(true);
            setDestination(current ?? '');
            setError('');
          }}
        >
          Move selected
        </button>
        <button disabled={busy || !selected.length} onClick={() => setSelected([])}>
          Clear selection
        </button>
      </div>
      {error && !creating && !moving && (
        <p role="alert">
          {error}{' '}
          {!creating && !moving && (
            <button onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          )}
        </p>
      )}
      <div
        className="forge-gallery-scroll"
        role="region"
        aria-label="Gallery contents"
        tabIndex={0}
      >
        {loading ? (
          <p role="status">Loading media…</p>
        ) : (
          <>
            {children.length > 0 && (
              <div className="forge-gallery-folders">
                {children.map((folder) => (
                  <button
                    className="forge-gallery-folder"
                    key={folder.id}
                    onClick={() => navigate(folder.id)}
                  >
                    <span aria-hidden="true">▱</span>
                    <strong>{folder.name}</strong>
                    <small>
                      {
                        galleryPictures.filter((picture) => placements[picture.id] === folder.id)
                          .length
                      }{' '}
                      items · {folders.filter((item) => item.parent === folder.id).length} folders
                    </small>
                  </button>
                ))}
              </div>
            )}
            <div className="forge-gallery-pictures">
              {visible.map((picture) => (
                <article
                  className={`forge-gallery-picture${selected.includes(picture.id) ? ' is-selected' : ''}`}
                  key={picture.id}
                >
                  <label className="forge-gallery-select">
                    <input
                      type="checkbox"
                      aria-label={`Select ${picture.name}`}
                      checked={selected.includes(picture.id)}
                      disabled={busy}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((ids) =>
                          checked ? [...ids, picture.id] : ids.filter((id) => id !== picture.id),
                        );
                      }}
                    />
                    Select
                  </label>
                  <div className="forge-gallery-media">{picture.media}</div>
                  <footer>
                    <span title={picture.name}>{picture.name}</span>
                    <button
                      disabled={busy}
                      aria-label={`Move ${picture.name}`}
                      onClick={() => {
                        setMoving([picture]);
                        setBatchMove(false);
                        setError('');
                        setDestination(current ?? '');
                      }}
                    >
                      Move
                    </button>
                    <button
                      disabled={busy}
                      aria-label={`Delete ${picture.name}`}
                      onClick={async () => {
                        if (
                          busy ||
                          !(await confirm({
                            title: 'Delete media?',
                            message: `Permanently delete “${picture.name}”? Its original Forge links will stop working. Archive history and copies already sent in chat stay intact.`,
                            confirmLabel: 'Delete',
                            tone: 'danger',
                          }))
                        )
                          return;
                        setBusy(true);
                        setError('');
                        try {
                          await owned.api(
                            `/api/forge/gallery/images/${encodeURIComponent(picture.jobId)}/${encodeURIComponent(picture.artifactId)}`,
                            { method: 'DELETE' },
                          );
                          setSelected((ids) => ids.filter((id) => id !== picture.id));
                          setCatalog((data) => ({
                            ...data,
                            images: data.images.filter(
                              (image) => `${image.jobId}:${image.artifactId}` !== picture.id,
                            ),
                          }));
                        } catch {
                          setError('Could not delete the media. Please try again.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </footer>
                </article>
              ))}
            </div>
            {!error && !visible.length && (
              <p className="forge-gallery-empty">
                {current
                  ? 'No media in this folder yet.'
                  : children.length
                    ? 'All media are in folders.'
                    : 'No generated images or videos yet.'}
              </p>
            )}
          </>
        )}
      </div>
      {creating && (
        <div className="forge-gallery-backdrop">
          <AccessibleModal
            className="forge-gallery-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="New folder"
            onClose={() => {
              if (!busy) {
                setCreating(false);
                setError('');
              }
            }}
          >
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!name.trim() || busy) return;
                setBusy(true);
                setError('');
                try {
                  const result = await owned.api<{ folder: Catalog['folders'][number] }>(
                    '/api/forge/gallery/folders',
                    {
                      method: 'POST',
                      body: JSON.stringify({ name: name.trim(), parentId: current }),
                    },
                  );
                  setCatalog((data) => ({ ...data, folders: [...data.folders, result.folder] }));
                  setCreating(false);
                } catch {
                  setError('Could not create the folder. Please try again.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h2>New folder</h2>
              {error && <p role="alert">{error}</p>}
              <label className="forge-field">
                Folder name
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                />
              </label>
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCreating(false);
                    setError('');
                  }}
                >
                  Cancel
                </button>
                <button disabled={busy || !name.trim()}>Create folder</button>
              </div>
            </form>
          </AccessibleModal>
        </div>
      )}
      {moving && (
        <div className="forge-gallery-backdrop">
          <AccessibleModal
            className="forge-gallery-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={batchMove ? 'Move selected' : 'Move image'}
            onClose={() => {
              if (!busy) {
                setMoving(null);
                setError('');
              }
            }}
          >
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                setError('');
                const results = await Promise.allSettled(
                  moving.map((picture) =>
                    owned.api(
                      `/api/forge/gallery/images/${encodeURIComponent(picture.jobId)}/${encodeURIComponent(picture.artifactId)}`,
                      { method: 'PUT', body: JSON.stringify({ folderId: destination || null }) },
                    ),
                  ),
                );
                const succeeded = new Set(
                  moving
                    .filter((_, index) => results[index].status === 'fulfilled')
                    .map((picture) => picture.id),
                );
                const failed = moving.filter((picture) => !succeeded.has(picture.id));
                setCatalog((data) => ({
                  ...data,
                  images: data.images.map((image) =>
                    succeeded.has(`${image.jobId}:${image.artifactId}`)
                      ? { ...image, folderId: destination || null }
                      : image,
                  ),
                }));
                setSelected((ids) => ids.filter((id) => !succeeded.has(id)));
                if (failed.length) {
                  setMoving(failed);
                  setError(
                    batchMove
                      ? `${succeeded.size} moved; ${failed.length} could not be moved. Retry will move only the remaining items.`
                      : 'Could not move the image. Please try again.',
                  );
                } else {
                  setMoving(null);
                }
                setBusy(false);
              }}
            >
              <h2>{batchMove ? `Move ${moving.length} selected items` : 'Move image'}</h2>
              {error && <p role="alert">{error}</p>}
              <label className="forge-field">
                Destination
                <select
                  disabled={busy}
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">Gallery (no folder)</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {path(folder)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMoving(null);
                    setError('');
                  }}
                >
                  Cancel
                </button>
                <button disabled={busy}>
                  {busy ? 'Moving…' : batchMove ? 'Move selected' : 'Move image'}
                </button>
              </div>
            </form>
          </AccessibleModal>
        </div>
      )}
    </section>
  );
}
