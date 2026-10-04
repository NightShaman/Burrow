import { AccessibleModal } from './AccessibleModal';
import { useRef, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './imagePreview.css';

export function ImagePreview(props: ImgHTMLAttributes<HTMLImageElement>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);
  return <><button ref={trigger} type="button" className="image-preview-trigger" aria-label={`Enlarge ${props.alt || 'image'}`} onClick={() => { trigger.current?.focus(); setActualSize(false); setFailed(false); setOpen(true); }}><img {...props} /></button>{open && createPortal(<div className="image-viewer-backdrop" onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}><AccessibleModal onClose={() => setOpen(false)} className="image-viewer" role="dialog" aria-modal="true" aria-label={props.alt || 'Image viewer'}><header><span>{props.alt || 'Image'}</span><button type="button" onClick={() => setActualSize(value => !value)}>{actualSize ? 'Fit to screen' : 'Actual size'}</button><button type="button" aria-label="Close image viewer" onClick={() => setOpen(false)}>×</button></header><div className={`image-viewer-stage${actualSize ? ' actual-size' : ''}`}>{failed ? <p role="alert">Image could not be loaded.</p> : <img src={props.src} alt={props.alt || 'Image'} onError={() => setFailed(true)} />}</div></AccessibleModal></div>, document.body)}</>;
}
