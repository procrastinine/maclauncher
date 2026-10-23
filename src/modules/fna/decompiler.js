const Shared = require("../shared/runtime/managed-decompiler");
const { inspectGameAssembly } = require("./detect");

async function decompile(entry, payload = {}, context, dependencies = {}) {
  Shared.selectedVersion(context, payload);
  const info = inspectGameAssembly(entry.moduleData?.assemblyPath || entry.gamePath);
  if (!info) throw new Error("No managed game entry point was found.");
  return Shared.decompileAssembly({ entry, payload, context, moduleId: "fna", assemblyPath: info.assemblyPath, gameVersion: info.gameVersion }, dependencies);
}
function reveal(entry, context) { return Shared.revealSource({ entry, context, moduleId: "fna" }); }

module.exports = { ...Shared, decompile, reveal };
