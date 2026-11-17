import React, { useContext, useEffect, useId, useMemo, useState } from "react";
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

/** Help text in which a hyphen before a digit, as in UTF-8 or Direct3D 10-12, does not end a line. */
export function keepNumberedTerms(text: string) {
  return text.replace(/(?<=\w)-(?=\d)/g, "\u2011");
}

export function HelpList({ items }: { items: HelpItem[] }) {
  return <dl className="helpList">
    {items.map(item => <React.Fragment key={item.label}><dt>{item.label}</dt><dd>{keepNumberedTerms(item.text)}</dd></React.Fragment>)}
  </dl>;
}

/** A section heading's help button; nothing when the section has nothing to explain. */
export function SectionHelp({ label, items, children }: { label: string; items: HelpItem[]; children?: React.ReactNode }) {
  if (!items.length && !children) return null;
  return <HelpTip label={label}>{children}{items.length > 0 && <HelpList items={items} />}</HelpTip>;
}

// Rows inside a collector list their explanations in the section heading's help
// instead of showing a help button each; outside one, a row keeps its own button.
type HelpRegistry = { set(id: string, item: HelpItem | null): void };
const HelpCollectorContext = React.createContext<HelpRegistry | null>(null);
export const HelpCollector = HelpCollectorContext.Provider;

/** The explanations the rows inside a HelpCollector report, in the order they appeared. */
export function useCollectedHelp(): { items: HelpItem[]; registry: HelpRegistry } {
  const [entries, setEntries] = useState<Array<[string, HelpItem]>>([]);
  const registry = useMemo<HelpRegistry>(() => ({ set(id, item) {
    setEntries(current => {
      const index = current.findIndex(([key]) => key === id);
      if (!item) return index < 0 ? current : current.filter(([key]) => key !== id);
      if (index < 0) return [...current, [id, item]];
      if (current[index][1].label === item.label && current[index][1].text === item.text) return current;
      const next = current.slice(); next[index] = [id, item]; return next;
    });
  } }), []);
  return { items: helpItems(entries.map(([, item]) => item)), registry };
}

/** A row's explanation: listed by the enclosing section heading's help, or its own help button outside a collector. */
export function RowHelp({ label, text }: { label: string; text: string }) {
  const registry = useContext(HelpCollectorContext), id = useId();
  useEffect(() => { registry?.set(id, { label, text }); }, [registry, id, label, text]);
  useEffect(() => () => registry?.set(id, null), [registry, id]);
  return registry ? null : <HelpTip label={`About ${label.toLowerCase()}`}>{text}</HelpTip>;
}
