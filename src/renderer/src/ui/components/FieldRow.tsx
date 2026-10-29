import React from "react";
import { HelpTip } from "./HelpTip";

export type FieldRowProps = {
  label: React.ReactNode;
  /** Help popover content, shown behind a "?" after the label. */
  help?: React.ReactNode;
  /** Accessible name of the help button; defaults to "About <label>". */
  helpLabel?: string;
  /** Id of the control, when the label should focus it. */
  labelFor?: string;
  className?: string;
  /** The control or value. */
  children?: React.ReactNode;
  /** Trailing buttons. */
  actions?: React.ReactNode;
};

// Label · control · trailing actions on the shared --field-label column.
export function FieldRow({ label, help, helpLabel, labelFor, className, children, actions }: FieldRowProps) {
  const name = typeof label === "string" ? label.toLowerCase() : "this setting";
  return <div className={["detailRow", "fieldRow", className].filter(Boolean).join(" ")}>
    <div className="detailLabel">
      {labelFor ? <label htmlFor={labelFor}>{label}</label> : label}
      {help ? <HelpTip label={helpLabel || `About ${name}`}>{help}</HelpTip> : null}
    </div>
    <div className="fieldControl">{children}</div>
    {actions ? <div className="detailActions">{actions}</div> : null}
  </div>;
}

// Every boolean row uses a bare checkbox; the row label names the setting.
export function Toggle({ label, checked, disabled, onChange }: {
  label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="inlineCheck settingsToggle">
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
      onChange={event => onChange(event.target.checked)} />
  </label>;
}
