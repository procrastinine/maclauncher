export function pathDisplayParts(value: string) {
  const path = String(value || "");
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { prefix: split < 0 ? "" : path.slice(0, split + 1), name: path.slice(split + 1) };
}

export function libraryLocationLabel({ bottle, sourceLabel, storeLabel, managed }: {
  bottle?: string | null; sourceLabel?: string; storeLabel?: string; managed?: boolean;
}) {
  if (bottle) return `CrossOver bottle: ${bottle}`;
  if (managed) return "MacLauncher downloads";
  return sourceLabel || storeLabel || "Local library";
}
