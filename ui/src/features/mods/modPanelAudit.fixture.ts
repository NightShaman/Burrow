export function mountControl({ root }: { root: HTMLElement }) {
  const partial = document.createElement('button');
  partial.textContent = 'Partial control';
  root.append(partial);
  throw new Error('Could not load control data');
}
