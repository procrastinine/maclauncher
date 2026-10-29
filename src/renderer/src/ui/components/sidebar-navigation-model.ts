export type SidebarItem = { id: string; label: string; title?: string; keywords?: string[]; heading?: string };
export type SidebarSection<T extends SidebarItem> = { key: string; heading: string; showHeading: boolean; items: T[]; start: number };

// Consecutive items that share a heading form one section. A heading that would
// only repeat its single item's label is not shown; the section stays separate.
export function sidebarSections<T extends SidebarItem>(items: T[]): SidebarSection<T>[] {
  const sections: SidebarSection<T>[] = [];
  items.forEach((item, index) => {
    const heading = item.heading || "";
    const last = sections.at(-1);
    if (last && last.heading === heading) last.items.push(item);
    else sections.push({ key: `${sections.length}:${heading}`, heading, showHeading: true, items: [item], start: index });
  });
  for (const section of sections) section.showHeading = Boolean(section.heading) &&
    !(section.items.length === 1 && section.items[0].label === section.heading);
  return sections;
}

const searchable = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export function filterSidebarItems<T extends SidebarItem>(items: T[], query: string): T[] {
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter(item => {
    const text = searchable([item.id, item.label, item.title, ...(item.keywords || [])].filter(Boolean).join(" "));
    return terms.every(term => text.includes(term));
  });
}

export function sidebarMovement(key: string, index: number, count: number): number | null {
  if (count < 1) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function sidebarSearchShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
}
