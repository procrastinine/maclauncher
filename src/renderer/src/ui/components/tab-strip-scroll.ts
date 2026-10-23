export type TabStripScrollState = {
  overflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
};

type ScrollMetrics = { clientWidth: number; scrollWidth: number; scrollLeft: number };

export function tabStripScrollState(viewport: ScrollMetrics, availableWidth = viewport.clientWidth): TabStripScrollState {
  const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const left = Math.max(0, Math.min(maximum, viewport.scrollLeft));
  // Compare against the full strip, including any currently visible arrows.
  // Otherwise their gutters would keep a nearly fitting strip overflowing.
  const overflow = availableWidth > 0 && viewport.clientWidth > 0 && viewport.scrollWidth > availableWidth + 1;
  return { overflow, canScrollLeft: overflow && left > 1, canScrollRight: overflow && maximum - left > 1 };
}

export function createTabStripScrollController(container: HTMLElement, viewport: HTMLElement,
  onChange: (state: TabStripScrollState) => void) {
  let selectedId: string | null = null;
  let state: TabStripScrollState | null = null;
  let disposed = false;
  let lastWidth = container.clientWidth;
  let lastViewportWidth = viewport.clientWidth;
  const observedTabs = new Set<HTMLElement>();

  function measure() {
    if (disposed) return;
    const next = tabStripScrollState(viewport, container.clientWidth);
    if (!state || next.overflow !== state.overflow || next.canScrollLeft !== state.canScrollLeft ||
      next.canScrollRight !== state.canScrollRight) {
      state = next;
      onChange(next);
    }
  }

  function revealSelected() {
    if (disposed || !selectedId || viewport.clientWidth <= 0) return;
    const tab = Array.from(viewport.querySelectorAll<HTMLElement>('[role="tab"]')).find(tab => tab.id === selectedId);
    if (!tab) return;
    const bounds = viewport.getBoundingClientRect(), selected = tab.getBoundingClientRect();
    const delta = selected.left < bounds.left ? selected.left - bounds.left
      : selected.right > bounds.left + viewport.clientWidth ? selected.right - bounds.left - viewport.clientWidth : 0;
    const left = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + delta));
    if (Math.abs(left - viewport.scrollLeft) > 1) viewport.scrollTo({ left, behavior: "auto" });
  }

  function resized() {
    if (disposed) return;
    const width = container.clientWidth, viewportWidth = viewport.clientWidth;
    if (width !== lastWidth || viewportWidth !== lastViewportWidth) revealSelected();
    lastWidth = width;
    lastViewportWidth = viewportWidth;
    measure();
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  observer?.observe(container);
  observer?.observe(viewport);
  viewport.addEventListener("scroll", measure, { passive: true });
  if (!observer && typeof window !== "undefined") window.addEventListener("resize", resized);

  function update(nextSelectedId: string | null) {
    if (disposed) return;
    const tabs = new Set(viewport.querySelectorAll<HTMLElement>('[role="tab"]'));
    for (const tab of observedTabs) if (!tabs.has(tab)) { observer?.unobserve(tab); observedTabs.delete(tab); }
    for (const tab of tabs) if (!observedTabs.has(tab)) { observer?.observe(tab); observedTabs.add(tab); }
    if (selectedId !== nextSelectedId) {
      selectedId = nextSelectedId;
      revealSelected();
    }
    measure();
  }

  function scroll(direction: -1 | 1) {
    if (disposed || !tabStripScrollState(viewport, container.clientWidth).overflow) return;
    const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const left = Math.max(0, Math.min(maximum, viewport.scrollLeft + direction * Math.max(1, viewport.clientWidth * 0.75)));
    viewport.scrollTo({ left, behavior: "auto" });
    measure();
  }

  function dispose() {
    disposed = true;
    observer?.disconnect();
    viewport.removeEventListener("scroll", measure);
    if (!observer && typeof window !== "undefined") window.removeEventListener("resize", resized);
  }

  return { update, scroll, dispose };
}
