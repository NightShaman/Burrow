// Root client dimensions describe the viewport, not the scrolled root DOMRect.
// Nested client dimensions describe the element's inner scrollport.
export function clientClipBox({
  root,
  rect,
  clientLeft,
  clientTop,
  clientWidth,
  clientHeight,
  viewportWidth,
  viewportHeight,
}) {
  if (root) return { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
  return {
    left: rect.left + clientLeft,
    top: rect.top + clientTop,
    right: rect.left + clientLeft + clientWidth,
    bottom: rect.top + clientTop + clientHeight,
  };
}
