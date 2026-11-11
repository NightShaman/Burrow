export type ImageOutputFormat = 'png' | 'jpeg' | 'webp' | 'gif';
export type ImageOptions = {
  outputFormat: ImageOutputFormat;
  frameCount?: number;
  frameDurationMs?: number;
  size?: string;
};
export type ImageDraft = {
  outputFormat: ImageOutputFormat;
  frameCount: string;
  frameDurationMs: string;
  size: string;
};
export const defaultImageDraft = (formats?: readonly ImageOutputFormat[]): ImageDraft => ({
  outputFormat: !formats || formats.includes('png') ? 'png' : (formats[0] ?? 'png'),
  frameCount: '9',
  frameDurationMs: '200',
  size: 'auto',
});
export const imageFormatLabels: Record<ImageOutputFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'Animated GIF',
};

export function roundedFrameDuration(value: string): number {
  return Math.round(Number(value) / 10) * 10;
}

export function imageDraftError(draft: ImageDraft): string {
  if (draft.outputFormat !== 'gif') return '';
  const frames = Number(draft.frameCount);
  if (!draft.frameCount.trim() || !Number.isInteger(frames) || frames < 2 || frames > 16)
    return 'Choose between 2 and 16 whole frames.';
  const delay = Number(draft.frameDurationMs);
  if (!draft.frameDurationMs.trim() || !Number.isFinite(delay) || delay < 20 || delay > 2000)
    return 'Choose a frame delay between 20 and 2000 ms.';
  return '';
}

export function imageDraftOptions(
  draft: ImageDraft,
  explicitFormat = false,
): ImageOptions | undefined {
  // The untouched still-image path retains the provider's existing defaults.
  if (draft.outputFormat === 'png' && !explicitFormat) return undefined;
  if (draft.outputFormat !== 'gif') return { outputFormat: draft.outputFormat };
  return {
    outputFormat: 'gif',
    frameCount: Number(draft.frameCount),
    frameDurationMs: roundedFrameDuration(draft.frameDurationMs),
    size: draft.size,
  };
}

export function ForgeImageOptions({
  draft,
  formats,
  sizes,
  disabled,
  onChange,
}: {
  draft: ImageDraft;
  formats: ImageOutputFormat[];
  sizes: string[];
  disabled: boolean;
  onChange: (draft: ImageDraft) => void;
}) {
  const error = imageDraftError(draft);
  const gif = draft.outputFormat === 'gif';
  return (
    <div className="forge-image-options">
      <label className="forge-field">
        <span>Output format</span>
        <select
          aria-label="Output format"
          value={draft.outputFormat}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...defaultImageDraft(),
              outputFormat: event.target.value as ImageOutputFormat,
            })
          }
        >
          {formats.map((format) => (
            <option key={format} value={format}>
              {imageFormatLabels[format]}
            </option>
          ))}
        </select>
      </label>
      {gif && (
        <>
          <div className="forge-gif-fields">
            <label className="forge-field">
              <span>Frames</span>
              <input
                type="number"
                aria-label="Frames"
                min={2}
                max={16}
                step={1}
                value={draft.frameCount}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, frameCount: event.target.value })}
              />
            </label>
            <label className="forge-field">
              <span>Delay (ms)</span>
              <input
                type="number"
                aria-label="Frame delay (ms)"
                min={20}
                max={2000}
                step={10}
                value={draft.frameDurationMs}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, frameDurationMs: event.target.value })}
                onBlur={() => {
                  if (!error)
                    onChange({
                      ...draft,
                      frameDurationMs: String(roundedFrameDuration(draft.frameDurationMs)),
                    });
                }}
              />
            </label>
            <label className="forge-field">
              <span>Size</span>
              <select
                aria-label="GIF size"
                value={draft.size}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, size: event.target.value })}
              >
                {sizes.map((size) => (
                  <option key={size} value={size}>
                    {size === 'auto' ? 'Auto' : size.replace('x', ' × ')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? (
            <p className="forge-error" role="alert">
              {error}
            </p>
          ) : (
            <output className="forge-gif-duration" aria-live="polite">
              Duration:{' '}
              {Number(
                (
                  (Number(draft.frameCount) * roundedFrameDuration(draft.frameDurationMs)) /
                  1000
                ).toFixed(2),
              )}{' '}
              s
            </output>
          )}
        </>
      )}
    </div>
  );
}
