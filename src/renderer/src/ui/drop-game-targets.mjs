// Graphics files that the library accepts beside games: shaders and neural models.
export const graphicsDropTargets = Object.freeze([
  { label: ".fx / .glsl / .hook", mono: true },
  { label: ".slang / .slangp", mono: true },
  { label: ".dlssmodel", mono: true }
]);

// Exclusive extensions describe standalone import inputs; ordinary detection
// files can instead be data inside a game folder.
export function dropGameTargets(modules = []) {
  const kinds = new Set(), formats = new Set(), extensions = new Set();
  for (const module of modules) {
    const detection = module.detection || {};
    for (const kind of detection.inputKinds || []) kinds.add(kind);
    for (const format of detection.binaryFormats || []) formats.add(format);
    for (const item of detection.extensions || []) {
      if (!item?.exclusive || typeof item.extension !== "string") continue;
      const extension = item.extension.replace(/^\./, "").toLowerCase();
      if (/^[a-z0-9_]+$/.test(extension)) extensions.add(extension);
    }
  }
  if (formats.has("pe")) extensions.add("exe");
  if (formats.has("elf")) extensions.add("x86_64");
  return [
    ...(kinds.has("directory") || !modules.length ? [{ label: "Game folder" }] : []),
    ...(kinds.has("app") ? [{ label: "Game.app", mono: true }] : []),
    ...[...extensions].sort().map(extension => ({
      label: `Game.${extension === "appimage" ? "AppImage" : extension}`, mono: true
    }))
  ];
}
