import type { KeyboardEvent } from 'react';
export function rovingKeys(event: KeyboardEvent<HTMLElement>, selector: string, activate = true) {
 const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
 const index = items.indexOf(document.activeElement as HTMLElement);
 let next: number;
 if (event.key === 'Home') next = 0;
 else if (event.key === 'End') next = items.length - 1;
 else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % items.length;
 else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
 else return;
 event.preventDefault(); items[next]?.focus(); if (activate) items[next]?.click();
}
