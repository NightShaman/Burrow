import { useEffect, useRef, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './imagePreview.css';

export function ImagePreview(props: ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (event.key === 'Tab') {
        const buttons = modal.current?.querySelectorAll<HTMLButtonElement>('button');
        if (!buttons?.length) return;
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keyboard); trigger.current?.focus(); };
  }, [open]);
  return <><button ref={trigger} type="button" className="image-preview-trigger" aria-label={`Enlarge ${props.alt || 'image'}`} onClick={() => { setActualSize(false); setFailed(false); setOpen(true); }}><img {...props} /></button>{open && createPortal(<div className="image-viewer-backdrop" onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}><div ref={modal} className="image-viewer" role="dialog" aria-modal="true" aria-label={props.alt || 'Image viewer'}><header><span>{props.alt || 'Image'}</span><button type="button" onClick={() => setActualSize(value => !value)}>{actualSize ? 'Fit to screen' : 'Actual size'}</button><button ref={close} type="button" aria-label="Close image viewer" onClick={() => setOpen(false)}>×</button></header><div className={`image-viewer-stage${actualSize ? ' actual-size' : ''}`}>{failed ? <p role="alert">Image could not be loaded.</p> : <img src={props.src} alt={props.alt || 'Image'} onError={() => setFailed(true)} />}</div></div></div>, document.body)}</>;
}
