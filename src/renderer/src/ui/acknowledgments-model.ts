export type Acknowledgment = { label: string; url: string };
type CreditSource = { acknowledgments?: readonly Acknowledgment[] };

export function collectAcknowledgments(
  modules: readonly CreditSource[],
  shared: readonly Acknowledgment[] = []
): Acknowledgment[] {
  const byUrl = new Map<string, Acknowledgment>();
  for (const item of [...shared, ...modules.flatMap(mod => mod.acknowledgments || [])]) {
    const url = item?.url?.trim();
    if (!url) continue;
    const key = url.replace(/\/+$/, "").toLowerCase();
    const label = (item.label || url).trim() || url;
    const existing = byUrl.get(key);
    if (!existing) byUrl.set(key, { label, url });
    else if (existing.label === existing.url && label !== url) {
      byUrl.set(key, { label, url: existing.url });
    }
  }
  return [...byUrl.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) ||
    a.url.localeCompare(b.url, undefined, { sensitivity: "base", numeric: true })
  );
}
