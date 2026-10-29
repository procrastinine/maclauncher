import React, { useEffect, useId, useRef, useState } from "react";
import { positionHelpTip, positionMenu } from "./help-tip-model";

export type PopoverPlacement = "side" | "below";

// Native popovers enter the top layer and close on an outside click. Escape also
// closes them and returns focus to the button; scrolling keeps them on the anchor.
export function usePopover<Anchor extends HTMLElement = HTMLButtonElement>(placement: PopoverPlacement = "side") {
  const id = useId();
  const anchorRef = useRef<Anchor>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  function position() {
    const anchor = anchorRef.current, popover = popoverRef.current;
    if (!anchor || !popover?.matches(":popover-open")) return;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      popover.hidePopover(); return;
    }
    const size = popover.getBoundingClientRect();
    const next = (placement === "below" ? positionMenu : positionHelpTip)(rect, size.width, size.height, innerWidth, innerHeight);
    popover.style.left = `${next.left}px`;
    popover.style.top = `${next.top}px`;
  }
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !popoverRef.current?.matches(":popover-open")) return;
      event.preventDefault(); event.stopPropagation();
      popoverRef.current.hidePopover(); anchorRef.current?.focus();
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
  function toggle(event?: { preventDefault(): void }) {
    event?.preventDefault();
    const popover = popoverRef.current;
    if (!popover) return;
    if (popover.matches(":popover-open")) { popover.hidePopover(); return; }
    // Measure in the top layer before revealing to avoid the browser's default
    // centered position flashing on screen.
    popover.style.visibility = "hidden";
    popover.showPopover(); position(); popover.style.visibility = "";
  }
  function hide() {
    if (popoverRef.current?.matches(":popover-open")) popoverRef.current.hidePopover();
  }
  return { id, open, anchorRef, popoverRef, toggle, hide,
    onToggle: (event: { newState: string }) => setOpen(event.newState === "open") };
}

export type PopoverButtonProps = {
  label: React.ReactNode;
  ariaLabel?: string;
  title?: string;
  className?: string;
  buttonClassName?: string;
  popoverClassName?: string;
  placement?: PopoverPlacement;
  disabled?: boolean;
  /** Close after a button inside the popover is activated, as menus do. */
  closeOnAction?: boolean;
  /** Called when the popover opens or closes. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

export function PopoverButton({ label, ariaLabel, title, className, buttonClassName = "btn small",
  popoverClassName = "menuPopover", placement = "below", disabled, closeOnAction = false, onOpenChange, children }: PopoverButtonProps) {
  const popover = usePopover(placement);
  return <span className={["popoverAnchor", className].filter(Boolean).join(" ")}>
    <button ref={popover.anchorRef} type="button" className={buttonClassName} popoverTarget={popover.id}
      aria-controls={popover.id} aria-label={ariaLabel} title={title} aria-expanded={popover.open}
      disabled={disabled} onClick={popover.toggle}>{label}</button>
    <div ref={popover.popoverRef} id={popover.id} popover="auto" className={popoverClassName}
      onToggle={event => {popover.onToggle(event);onOpenChange?.(event.newState === "open");}}
      onClick={closeOnAction ? event => {
        if (!(event.target as Element).closest?.("button:not(:disabled)")) return;
        popover.hide(); popover.anchorRef.current?.focus();
      } : undefined}>{children}</div>
  </span>;
}

export function MenuButton(props: Omit<PopoverButtonProps, "closeOnAction">) {
  return <PopoverButton {...props} closeOnAction />;
}
