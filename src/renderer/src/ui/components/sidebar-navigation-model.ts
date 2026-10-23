export type SidebarItem = { id: string; label: string; title?: string; keywords?: string[] };

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
