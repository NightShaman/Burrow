import type { ComponentProps } from 'react';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const markdownPlugins = [remarkGfm, remarkBreaks];

export function MarkdownTable({ children, ...props }: ComponentProps<'table'>) {
  return <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0}><table {...props}>{children}</table></div>;
}
