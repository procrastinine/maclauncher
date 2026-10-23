import React, { useEffect, useId, useRef, useState } from "react";
import { positionHelpTip } from "./help-tip-model";

export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  function position() {
    const button = buttonRef.current, popover = popoverRef.current;
    if (!button || !popover?.matches(":popover-open")) return;
    const anchor = button.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight || anchor.right < 0 || anchor.left > innerWidth) {
      popover.hidePopover(); return;
    }
    const size = popover.getBoundingClientRect();
    const next = positionHelpTip(anchor, size.width, size.height, innerWidth, innerHeight);
    popover.style.left = `${next.left}px`;
    popover.style.top = `${next.top}px`;
  }
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !popoverRef.current?.matches(":popover-open")) return;
      event.preventDefault(); event.stopPropagation();
      popoverRef.current.hidePopover(); buttonRef.current?.focus();
    }
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);
  return <span className="helpTip">
    <button type="button" className="helpTipButton" popoverTarget={id}
      ref={buttonRef} title={label} aria-label={label} aria-expanded={open}
      onClick={event => {
        event.preventDefault();
        const popover = popoverRef.current;
        if (!popover) return;
        if (popover.matches(":popover-open")) { popover.hidePopover(); return; }
        // Native popovers enter the top layer. Measure there before revealing
        // to avoid the browser's default centered position flashing on screen.
        popover.style.visibility = "hidden";
        popover.showPopover(); position(); popover.style.visibility = "";
      }}>?</button>
    <div ref={popoverRef} id={id} popover="auto" className="helpPopover"
      onToggle={event => setOpen(event.newState === "open")}>{children}</div>
  </span>;
}
