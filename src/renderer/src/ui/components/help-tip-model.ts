type AnchorRect = { left: number; right: number; top: number; bottom: number };

export function positionHelpTip(anchor: AnchorRect, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const edge = 8, gap = 8;
  const clamp = (value: number, maximum: number) => Math.max(edge, Math.min(value, Math.max(edge, maximum)));
  let left = anchor.right + gap, top = anchor.top - 4;
  if (left + width > viewportWidth - edge) {
    left = anchor.left - width - gap;
    if (left < edge) {
      left = anchor.left;
      top = anchor.bottom + gap;
      if (top + height > viewportHeight - edge) top = anchor.top - height - gap;
    }
  }
  return { left: clamp(left, viewportWidth - width - edge), top: clamp(top, viewportHeight - height - edge) };
}
