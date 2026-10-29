import React from "react";
import { formatUserError } from "../ui-helpers";
import { XIcon } from "../icons";

// Errors always read as plain sentences: no "Error:" or IPC prefix. Inline errors
// sit beside the control that failed; banners can be dismissed.
export function ErrorText({ error, inline = false, className, onDismiss }: {
  error: unknown; inline?: boolean; className?: string; onDismiss?: () => void;
}) {
  if (error == null || error === false || error === "") return null;
  return <div className={["error", inline ? "errorInline" : "", onDismiss ? "errorDismissible" : "", className].filter(Boolean).join(" ")}
    role="alert">
    <span className="errorMessage">{formatUserError(error)}</span>
    {onDismiss && <button type="button" className="btn small iconOnly errorDismiss" title="Dismiss" aria-label="Dismiss error"
      onClick={onDismiss}><XIcon /></button>}
  </div>;
}
