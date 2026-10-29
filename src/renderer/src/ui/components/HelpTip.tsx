import React from "react";
import { usePopover } from "./Popover";

export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  const popover = usePopover();
  return <span className="helpTip">
    <button type="button" className="helpTipButton" popoverTarget={popover.id}
      ref={popover.anchorRef} title={label} aria-label={label} aria-expanded={popover.open}
      onClick={popover.toggle}>?</button>
    <div ref={popover.popoverRef} id={popover.id} popover="auto" className="helpPopover"
      onToggle={popover.onToggle}>{children}</div>
  </span>;
}
