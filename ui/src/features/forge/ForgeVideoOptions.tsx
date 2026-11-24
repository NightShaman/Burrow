type WorkflowId = 'text-to-video' | 'image-to-video' | 'reference-to-video';
type Workflow = {
  id: WorkflowId;
  minImages: number;
  maxImages: number;
  durationSeconds: { min: number; max: number; default: number };
  aspectRatios: string[];
  resolutions: string[];
  defaults: { aspectRatio?: string; resolution?: string };
};
export type VideoCapability = {
  defaultWorkflow: WorkflowId;
  defaultReferenceWorkflow: WorkflowId;
  workflows: Workflow[];
};
export type VideoOptions = {
  workflow?: WorkflowId;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
};
const labels: Record<WorkflowId, string> = {
  'text-to-video': 'Text prompt',
  'image-to-video': 'Starting frame',
  'reference-to-video': 'Subject references',
};
function workflowFor(capability: VideoCapability, options: VideoOptions, imageCount: number) {
  const id =
    options.workflow ??
    (imageCount ? capability.defaultReferenceWorkflow : capability.defaultWorkflow);
  return capability.workflows.find((w) => w.id === id);
}
// Use the *prospective* image count for add actions: the first image can switch
// Auto into a different workflow, with different limits, before it enters the draft.
export function videoConflict(
  capability: VideoCapability,
  options: VideoOptions,
  imageCount: number,
  allowMissingImage = false,
) {
  const w = workflowFor(capability, options, imageCount);
  if (!w) return 'This workflow is unavailable. Choose another workflow.';
  if (imageCount > w.maxImages)
    return w.maxImages === 0
      ? 'Text prompt does not use images.'
      : `${labels[w.id]}: ${w.maxImages} ${w.maxImages === 1 ? 'image' : 'images'} maximum.`;
  if (options.aspectRatio && !w.aspectRatios.includes(options.aspectRatio))
    return w.aspectRatios.length
      ? `Choose an aspect ratio supported by ${labels[w.id].toLowerCase()}.`
      : 'Choose the default aspect ratio to use a starting frame.';
  if (options.resolution && !w.resolutions.includes(options.resolution))
    return `${labels[w.id]}: choose ${w.resolutions.join(' or ')}.`;
  if (
    options.durationSeconds !== undefined &&
    (!Number.isInteger(options.durationSeconds) ||
      options.durationSeconds < w.durationSeconds.min ||
      options.durationSeconds > w.durationSeconds.max)
  )
    return `${labels[w.id]}: choose ${w.durationSeconds.min}–${w.durationSeconds.max} seconds.`;
  if (!allowMissingImage && imageCount < w.minImages)
    return w.id === 'image-to-video'
      ? 'Select one image as the starting frame.'
      : 'Select a subject reference image.';
  return '';
}

export function ForgeVideoOptions({
  capability,
  options,
  imageCount,
  disabled,
  onChange,
}: {
  capability: VideoCapability;
  options: VideoOptions;
  imageCount: number;
  disabled: boolean;
  onChange: (next: VideoOptions) => void;
}) {
  const workflow = workflowFor(capability, options, imageCount);
  const inferred = workflowFor(capability, {}, imageCount);
  const update = <K extends keyof VideoOptions>(key: K, value: VideoOptions[K]) => {
    const next = { ...options };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const workflowOption = (id?: WorkflowId) => {
    const reason = videoConflict(capability, { ...options, workflow: id }, imageCount, true);
    const name = id ? labels[id] : `Auto${inferred ? ` · ${labels[inferred.id]}` : ''}`;
    return (
      <option key={id ?? ''} value={id ?? ''} disabled={!!reason}>
        {name}
        {reason && ` — ${reason}`}
      </option>
    );
  };
  const field = (
    label: string,
    key: 'aspectRatio' | 'resolution' | 'durationSeconds',
    values: (string | number)[],
    fallback?: string | number,
    inherited = false,
  ) => {
    const suffix = key === 'durationSeconds' ? ' s' : '';
    const value = options[key];
    return (
      <label className="forge-field">
        <span>{label}</span>
        <select
          aria-label={label}
          value={value ?? ''}
          disabled={disabled || (!values.length && value === undefined)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            if (key === 'durationSeconds') update(key, raw ? Number(raw) : undefined);
            else update(key, raw || undefined);
          }}
        >
          <option value="">
            {inherited
              ? 'From image'
              : fallback !== undefined
                ? `${fallback}${suffix} (default)`
                : 'Default'}
          </option>
          {value !== undefined && !values.includes(value) && (
            <option value={value} disabled>
              {value}
              {suffix} (unavailable)
            </option>
          )}
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
              {suffix}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const duration = workflow?.durationSeconds;
  return (
    <div className="forge-video-options">
      <label className="forge-field">
        <span>Workflow</span>
        <select
          aria-label="Workflow"
          value={options.workflow ?? ''}
          disabled={disabled}
          onChange={(e) =>
            update('workflow', (e.currentTarget.value || undefined) as WorkflowId | undefined)
          }
        >
          {workflowOption()}
          {options.workflow && !workflow && (
            <option value={options.workflow} disabled>
              {labels[options.workflow]} (unavailable)
            </option>
          )}
          {capability.workflows.map((w) => workflowOption(w.id))}
        </select>
      </label>
      {field(
        'Duration',
        'durationSeconds',
        duration
          ? Array.from({ length: duration.max - duration.min + 1 }, (_, i) => duration.min + i)
          : [],
        duration?.default,
      )}
      {field(
        'Aspect ratio',
        'aspectRatio',
        workflow?.aspectRatios ?? [],
        workflow?.defaults.aspectRatio,
        workflow?.aspectRatios.length === 0,
      )}
      {field(
        'Resolution',
        'resolution',
        workflow?.resolutions ?? [],
        workflow?.defaults.resolution,
      )}
    </div>
  );
}
