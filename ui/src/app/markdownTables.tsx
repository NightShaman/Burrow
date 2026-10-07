import { useState, type ComponentProps } from 'react';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const markdownPlugins = [remarkGfm, remarkBreaks];

export function MarkdownTable({ children, ...props }: ComponentProps<'table'>) {
  return <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0}><table {...props}>{children}</table></div>;
}

/** External Markdown media is opt-in to avoid an implicit outbound request. */
export function MarkdownImage({ src, alt, title, ...props }: ComponentProps<'img'>) {
  const [allowedSource, setAllowedSource] = useState<string | null>(null);
  if (!src || ! /^(?:https?:)?\/\//i.test(src)) return <img src={src} alt={alt ?? ''} title={title} {...props} />;
  if (allowedSource !== src) return <button type="button" className="markdown-external-image" onClick={() => setAllowedSource(src!)} aria-label={`Load external image${alt ? `: ${alt}` : ''}`}>Load external image{alt ? ` · ${alt}` : ''}</button>;
  return <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" {...props} />;
}
