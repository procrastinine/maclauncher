const fs = require("node:fs"), path = require("node:path");
const Custom = require("./custom-runtime");

// A component root is retained intact: libraries, notices and future companion
// files belong to the publisher, rather than a launcher inventory.
function componentRoot(input, { names }) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return path.dirname(input);
  const files = require("./translator-description").describeTranslator(input, { engine: "dxvk" }).files;
  for (const file of files) {
    const parts = file.relative.split(path.sep), index = parts.findIndex(part => names.includes(part.toLowerCase()));
    if (index >= 0) return path.join(input, ...parts.slice(0, index + 1));
  }
  return input;
}
function description(root, definition, options = {}) {
  return require("./translator-description").describeTranslator(root, { engine: definition.engine, ...options });
}
function inspected(root, definition, options) {
  const translator = description(root, definition, options);
  const file = translator.files.find(file => file.format === "macho" || file.format === "pe");
  if (!file) throw Error("The component contains no loadable library.");
  const executablePath = path.resolve(root, file.path);
  return { executablePath, installDir: root, root, payloadRoot: root, translatorRoot: root, translator,
    architectures: [...new Set(translator.files.flatMap(file => file.architectures || file.cpuSlices || file.slices?.map(slice => slice.architecture) || []))],
    versionLabel: translator.version, baseRoot: fs.existsSync(path.join(root, "wine")) ? path.join(root, "wine") : root };
}
function configure(manager, definition) {
  Custom.configure(manager, { prepare: prepareArchive, inspect(input, { data } = {}) {
    const root = componentRoot(data?.root || input, definition);
    const source = data?.source || (fs.existsSync(path.join(input, "Contents/SharedSupport/CrossOver"))
      ? { kind: "crossover", id: input, runtime: "crossover", label: "CrossOver" }
      : /(?:^|\/)Frameworks\/renderer(?:\/|$)/.test(root) ? { kind: "sikarugir", id: input, runtime: "sikarugir", label: "Sikarugir" } : "custom");
    return inspected(root, definition, { source });
  } });
  const selection = manager.resolveSelection;
  manager.resolveSelection = function(...args) {
    const result = selection.apply(this, args);
    if (!result?.install || result.install.translator) return result;
    const root = componentRoot(result.install.installDir, definition);
    return { ...result, install: { ...result.install, ...inspected(root, definition, { source: result.install.catalogEntry?.catalogSourceId || "upstream" }) } };
  };
  return manager;
}
module.exports = { componentRoot, description, inspected, configure };

// A downloaded local container is unpacked once into shared launcher storage.
// Directory registrations stay at the supplied location and remain references.
async function prepareArchive(input, { userDataDir } = {}) {
  if (!require("./release-files").archiveFormat(input)) return {};
  const sha256 = require("./pinned-native-manager").hashFile(input);
  const base = path.join(userDataDir, "runtimes", "imports"), root = path.join(base, sha256);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(base, { recursive: true });const staging = fs.mkdtempSync(path.join(base, ".import-"));
    try {
      if (/\.dmg$/i.test(input)) await require("./dmg").extractDmg(input, staging);
      else await require("./safe-archive").extractArchive(input, staging);
      fs.renameSync(staging, root);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { root, source: "custom" };
}
module.exports.prepareArchive = prepareArchive;
