import React from "react";
import { HelpTip } from "./HelpTip";

// One help button per section: its popover explains each row by name, and each
// row's label keeps its own explanation as a tooltip.
export type HelpItem = { label: string; text: string };

/** The rows of a section that have an explanation, in their order. */
export function helpItems(rows: Array<{ label?: unknown; text?: unknown } | null | undefined | false>): HelpItem[] {
  return rows.flatMap(row => row && typeof row.label === "string" && typeof row.text === "string" && row.label.trim() && row.text.trim()
    ? [{ label: row.label.trim(), text: row.text.trim() }] : []);
}

export function HelpList({ items }: { items: HelpItem[] }) {
  return <dl className="helpList">
    {items.map(item => <React.Fragment key={item.label}><dt>{item.label}</dt><dd>{item.text}</dd></React.Fragment>)}
  </dl>;
}

/** A section heading's help button; nothing when the section has nothing to explain. */
export function SectionHelp({ label, items, children }: { label: string; items: HelpItem[]; children?: React.ReactNode }) {
  if (!items.length && !children) return null;
  return <HelpTip label={label}>{children}{items.length > 0 && <HelpList items={items} />}</HelpTip>;
}
