import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronIcon } from "../icons";
import { createTabStripScrollController } from "./tab-strip-scroll";
import type { TabStripScrollState } from "./tab-strip-scroll";

type ScrollableTabStripProps = {
  label: string;
  selectedTabId: string | null;
  className?: string;
  tabsClassName: string;
  children: React.ReactNode;
};

export function ScrollableTabStrip({ label, selectedTabId, className, tabsClassName, children }: ScrollableTabStripProps) {
  const container = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createTabStripScrollController> | null>(null);
  const [scroll, setScroll] = useState<TabStripScrollState>({ overflow: false, canScrollLeft: false, canScrollRight: false });

  useLayoutEffect(() => {
    controller.current = createTabStripScrollController(container.current!, viewport.current!, setScroll);
    return () => { controller.current?.dispose(); controller.current = null; };
  }, []);
  useLayoutEffect(() => { controller.current?.update(selectedTabId); }, [selectedTabId, children]);

  return <div ref={container} className={["scrollableTabStrip", className].filter(Boolean).join(" ")}>
    <button type="button" className="tabStripArrow" aria-label={`Scroll ${label} left`} title={`Scroll ${label} left`}
      hidden={!scroll.overflow} disabled={!scroll.canScrollLeft} onClick={() => controller.current?.scroll(-1)}>
      <ChevronIcon direction="left" />
    </button>
    <div ref={viewport} className={`scrollableTabStripViewport ${tabsClassName}`} role="tablist" aria-label={label}>
      {children}
    </div>
    <button type="button" className="tabStripArrow" aria-label={`Scroll ${label} right`} title={`Scroll ${label} right`}
      hidden={!scroll.overflow} disabled={!scroll.canScrollRight} onClick={() => controller.current?.scroll(1)}>
      <ChevronIcon direction="right" />
    </button>
  </div>;
}
