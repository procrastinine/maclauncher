import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { XIcon } from "../icons";
import { filterSidebarItems, sidebarMovement, sidebarSearchShortcut, sidebarSections } from "./sidebar-navigation-model";
import type { SidebarItem } from "./sidebar-navigation-model";

type SearchableSidebarProps = {
  label: string;
  searchLabel: string;
  items: SidebarItem[];
  selectedId: string | null;
  panelId: string;
  selectionKey?: string;
  onSelect: (id: string) => void;
};

export function SearchableSidebar({ label, searchLabel, items, selectedId, panelId, selectionKey = selectedId || "", onSelect }: SearchableSidebarProps) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const visible = useMemo(() => filterSidebarItems(items, query), [items, query]);
  const sections = useMemo(() => sidebarSections(visible), [visible]);
  const headed = sections.some(section => section.heading);
  const headingIds = useId();
  const tabStop = visible.find(item => item.id === selectedId)?.id || visible[0]?.id;
  const previousSelection = useRef(selectionKey);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !sidebarSearchShortcut(event)) return;
      event.preventDefault(); search.current?.focus(); search.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { buttons.current.get(selectedId || "")?.scrollIntoView({ block: "nearest" }); }, [selectedId, query]);
  useEffect(() => {
    if (previousSelection.current !== selectionKey && query && !visible.some(item => item.id === selectedId)) setQuery("");
    previousSelection.current = selectionKey;
  }, [selectionKey, selectedId, visible, query]);

  const focusItem = (index: number, select = false) => {
    const item = visible[index];
    if (!item) return;
    if (select) onSelect(item.id);
    buttons.current.get(item.id)?.focus();
  };

  const choice = (item: SidebarItem, index: number) => <li key={item.id}>
    <button type="button" ref={button => { if (button) buttons.current.set(item.id, button); else buttons.current.delete(item.id); }}
      className={`launcherSidebarItem${item.id === selectedId ? " active" : ""}`}
      aria-current={item.id === selectedId ? "page" : undefined}
      aria-controls={item.id === selectedId ? panelId : undefined} title={item.title || item.label}
      tabIndex={item.id === tabStop ? 0 : -1} onClick={() => onSelect(item.id)}
      onKeyDown={event => {
        const next = sidebarMovement(event.key, index, visible.length);
        if (next === null) return;
        event.preventDefault(); focusItem(next, true);
      }}>{item.label}</button>
  </li>;

  return <aside className="launcherSidebar" aria-label={label}>
    <div className="launcherSidebarSearch" role="search" aria-label={searchLabel}>
      <input ref={search} className="input" type="search" aria-label={searchLabel} placeholder={searchLabel}
        value={query} autoComplete="off" spellCheck={false} onChange={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); focusItem(event.key === "ArrowDown" ? 0 : visible.length - 1);
          } else if (event.key === "Enter" && visible.length) { event.preventDefault(); focusItem(0, true); }
        }} />
      {query && <button type="button" className="launcherSidebarClear" aria-label={`Clear ${searchLabel.toLowerCase()}`}
        onClick={() => { setQuery(""); search.current?.focus(); }}><XIcon size="0.85em" /></button>}
    </div>
    <nav className="launcherSidebarChoices" aria-label={label}>
      {headed ? sections.map((section, sectionIndex) => {
        const headingId = `${headingIds}-heading-${sectionIndex}`;
        return <div key={section.key} className={`launcherSidebarSection${section.showHeading ? "" : " unlabeled"}`} role="group"
          aria-labelledby={section.showHeading ? headingId : undefined} aria-label={section.showHeading ? undefined : section.heading || undefined}>
          {section.showHeading && <h2 className="launcherSidebarHeading" id={headingId}>{section.heading}</h2>}
          <ul className="launcherSidebarList">{section.items.map((item, offset) => choice(item, section.start + offset))}</ul>
        </div>;
      }) : <ul className="launcherSidebarList">{visible.map(choice)}</ul>}
      {!visible.length && <p className="launcherSidebarEmpty" role="status">No matching sections.</p>}
    </nav>
  </aside>;
}
