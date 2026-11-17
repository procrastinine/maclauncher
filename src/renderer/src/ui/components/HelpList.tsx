import React from "react";
import { HelpTip } from "./HelpTip";

// One help button per section: its popover explains each row by name, and each
// row's label keeps its own explanation as a tooltip.
export type HelpItem = { label: string; text: string };

/** Several labels as one: a shared leading part is named once, as in "Direct3D 8, 9 and 12". */
export function joinHelpLabels(labels: string[]) {
  if (labels.length < 2) return labels[0] || "";
  const words = labels.map(label => label.split(" "));
  let shared = 0;
  while (words.every(parts => parts.length > shared + 1 && parts[shared] === words[0][shared])) shared++;
  const prefix = words[0].slice(0, shared).join(" "), rest = words.map(parts => parts.slice(shared).join(" "));
  return (prefix ? prefix + " " : "") + rest.slice(0, -1).join(", ") + " and " + rest[rest.length - 1];
}

/** The rows of a section that have an explanation, in their order; neighbouring rows with the same explanation share one entry. */
export function helpItems(rows: Array<{ label?: unknown; text?: unknown } | null | undefined | false>): HelpItem[] {
  const groups: Array<{ labels: string[]; text: string }> = [];
  for (const row of rows) {
    if (!row || typeof row.label !== "string" || typeof row.text !== "string" || !row.label.trim() || !row.text.trim()) continue;
    const label = row.label.trim(), text = row.text.trim(), last = groups[groups.length - 1];
    if (last?.text === text) last.labels.push(label); else groups.push({ labels: [label], text });
  }
  return groups.map(group => ({ label: joinHelpLabels(group.labels), text: group.text }));
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
