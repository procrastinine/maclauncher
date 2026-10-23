const fs = require("node:fs");
const path = require("node:path");
const Managed = require("./managed-consumer");
const Profiles = require("./profiles");
const ProfileCatalog = require("./profiles.json");
const HelperCatalog = require("./versions.json");

/** Select only an exact, independently attributed managed consumer. Unknown
 * or mixed consumers keep their complete native import requirements. */
async function selectManagedProfile({ imports, architecture, signal, profiles = ProfileCatalog, catalog = HelperCatalog } = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(imports) || !imports.length || imports.length > 4096) return {};
  const arch = architecture === "x64" ? "x86_64" : architecture;
  const first = imports[0];
  if (!path.isAbsolute(first?.assemblyPath || "") || first.resourceName && !first.range) return {};
  const identity = item => JSON.stringify([item.assemblyPath, item.resourceName ?? null, item.range ?? null]);
  if (imports.some(item => identity(item) !== identity(first))) return {};
  const source = { assemblyPath: first.assemblyPath, ...(first.range ? { range: { ...first.range } } : {}) };
  let size;
  try { size = source.range?.size ?? (await fs.promises.lstat(source.assemblyPath)).size; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return {}; throw error; }
  const candidates = profiles.filter(profile => profile.managedConsumer?.assemblyBytes === size && profile.architectures?.includes(arch));
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const profile = Profiles.resolveProfile({ id: candidate.id, architecture: arch,
      pin: catalog.find(pin => pin.version === candidate.helperVersion), profiles });
    try {
      await Managed.resolveManagedRequirement({ profile, sources: [source], symbols: imports.map(item => item.name), signal });
      return { abiProfile: profile.id, version: profile.helperVersion, managedConsumers: [source] };
    } catch (error) {
      // A different assembly, including an unchanged 32-bit edition, never
      // receives this profile merely because its name or size matches.
      if (error.code === "STEAM_API_CONSUMER_CHANGED") continue;
      throw error;
    }
  }
  return {};
}

module.exports = { selectManagedProfile };
