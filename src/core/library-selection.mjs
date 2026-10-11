export function toggleLibrarySelection(selected, visiblePaths, gamePath, anchor, range = false) {
  const visible = new Set(visiblePaths);
  const next = new Set(selected.filter(path => visible.has(path)));
  if (!visible.has(gamePath)) return { selected: [...next], anchor: visible.has(anchor) ? anchor : null };
  const target = visiblePaths.indexOf(gamePath);
  const start = range ? visiblePaths.indexOf(anchor) : -1;
  const paths = start < 0 ? [gamePath] : visiblePaths.slice(Math.min(start, target), Math.max(start, target) + 1);
  const add = !next.has(gamePath);
  for (const path of paths) { if (add) next.add(path); else next.delete(path); }
  return { selected: [...next], anchor: range && start >= 0 ? anchor : gamePath };
}
