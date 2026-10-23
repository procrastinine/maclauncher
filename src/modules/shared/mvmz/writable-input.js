const path = require("node:path");
const Writable = require("../writable-input");

function prepareInput(entry, context = {}) {
  if (!Writable.immutableRoot(entry)) return entry;
  const root = Writable.sourceRoot(entry);
  const existing = entry.moduleData?.writableInput;
  const sourceIndex = entry.indexDir === existing?.indexRoot ? existing.sourceIndex : entry.indexDir || path.dirname(entry.indexHtml);
  const relativeIndex = path.relative(root, sourceIndex);
  if (relativeIndex === ".." || relativeIndex.startsWith(".." + path.sep) || path.isAbsolute(relativeIndex)) {
    throw new Error("RPG Maker index is outside its source content.");
  }
  const indexPath = relative => path.join(relativeIndex, relative);
  const sourceHtml = entry.indexHtml && existing?.root && entry.indexHtml.startsWith(existing.root + path.sep)
    ? path.join(root, path.relative(existing.root, entry.indexHtml)) : entry.indexHtml || path.join(sourceIndex, "index.html");
  const indexHtml = path.relative(root, sourceHtml);
  const savePrefix = indexPath("save") + path.sep;
  const jsPrefix = indexPath("js") + path.sep;
  const view = Writable.ensureView(entry, context, {
    moduleId: entry.moduleId || entry.engine,
    policyId: "mvmz-scripts-v1",
    contentRoot: root,
    privateFile: relative => relative.startsWith(jsPrefix) && /\.(?:js|json)$/i.test(relative) ||
      [indexHtml, "package.json"].includes(relative),
    seedFile: relative => relative.startsWith(savePrefix),
    emptyDirectories: [indexPath("save"), indexPath("js/plugins/maclauncher"), indexPath("maclauncher-libs")]
  });
  view.sourceIndex = sourceIndex;
  view.indexRoot = path.join(view.root, relativeIndex);
  Writable.rememberView(entry, view);
  entry.defaultSaveDir = path.join(view.indexRoot, "save");
  return Writable.runtimeEntry(entry);
}

module.exports = { prepareInput };
