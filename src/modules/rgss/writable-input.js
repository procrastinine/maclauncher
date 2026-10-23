const path = require("node:path");
const Writable = require("../shared/writable-input");

function prepareInput(entry, context = {}) {
  if (!Writable.immutableRoot(entry)) return entry;
  const view = Writable.ensureView(entry, context, {
    moduleId: "rgss", policyId: "rgss-portable-v1",
    privateFile: relative => /\.(?:ini|cfg|json|rb|txt)$/i.test(relative),
    // RGSS portable saves are written beside Game.ini; databases and packed
    // scripts below Data/ remain immutable inputs.
    seedFile: relative => !relative.includes(path.sep) && /\.(?:rxdata|rvdata2?|sav|save|dat)$/i.test(relative)
  });
  Writable.rememberView(entry, view);
  entry.defaultSaveDir = view.root;
  return Writable.runtimeEntry(entry);
}

module.exports = { prepareInput };
