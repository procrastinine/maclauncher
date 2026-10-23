#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const B = require("../src/modules/shared/runtime/bundled-native");
const { managers, requiresDistribution, loadCommands } = require("./stage-native-runtimes.cjs");
const { distributionArchitectures, requiredVersions } = require("./distribution-model.cjs");

function sourceOnlyManagers() {
  // Retain the exported name for existing release scripts. Metadata can also
  // require complete bundles for managers with bootstrap download assets.
  return [...managers().values()].filter(requiresDistribution);
}
function bundleDirectories(resourceRoot, managerId, arch) {
  if (!/^[a-z0-9-]+$/.test(managerId || "") || !["arm64", "x64"].includes(arch)) throw new Error("Choose a safe runtime manager and architecture.");
  const root = path.join(resourceRoot, managerId), directories = [];
  if (!B.realDirectory(root)) return directories;
  const legacy = path.join(root, arch);
  if (fs.existsSync(legacy)) directories.push({ directory: legacy, legacy: true });
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (["arm64", "x64"].includes(item.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)) continue;
    const directory = path.join(root, item.name, arch);
    if (fs.existsSync(directory)) directories.unshift({ directory, version: item.name, legacy: false });
  }
  return directories;
}
function verifyPackages({ resourceRoot = path.resolve(__dirname, "../src/resources/native-runtimes"),
  architectures = [process.arch], managerIds, versions, requiredOnly = false, maximumMacOS = "13.0", signingIdentity, dependencies = {} } = {}) {
  const catalog = (dependencies.managers || managers)(), selected = managerIds || [...catalog.values()].filter(requiresDistribution).map(manager => manager.id), results = [], inspected = new Set();
  const inspectCommands = dependencies.loadCommands || loadCommands;
  const verifySignature = dependencies.verifySignature || (executable => execFileSync("/usr/bin/codesign", ["--verify", "--strict", executable], { timeout: 30000, stdio: "pipe" }));
  if (selected.some(id => !catalog.has(id)) || !architectures.length || architectures.some(arch => !["arm64", "x64"].includes(arch))) throw new Error("Choose known runtime managers and explicit arm64/x64 package architectures.");
  if (versions !== undefined && (!Array.isArray(versions) || !versions.length || versions.some(version => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "")))) throw new Error("Choose safe explicit package versions.");
  if (typeof requiredOnly !== "boolean" || requiredOnly && versions !== undefined) throw new Error("Choose either required package versions or an explicit version list.");
  for (const requestedArch of architectures) {
    for (const managerId of selected) {
      const manager = catalog.get(managerId);
      for (const arch of distributionArchitectures(manager, requestedArch)) {
      const identity = `${managerId}/${arch}`; if (inspected.has(identity)) continue; inspected.add(identity);
      const locations = bundleDirectories(resourceRoot, managerId, arch), seen = new Set();
      if (!locations.length) throw new Error(`Missing or damaged ${managerId}/${arch} bundle. Run scripts/stage-native-runtimes.cjs with a pinned artifact inventory before packaging.`);
      const required = versions || (requiredOnly ? requiredVersions(manager) : manager.distributionVersions || []);
      if (!Array.isArray(required) || required.some(version => !manager.core.catalog.some(pin => pin.version === version))) throw new Error("Required runtime versions must be explicit catalog entries.");
      for (const location of locations) {
      if (requiredOnly && location.version && !required.includes(location.version)) continue;
      const directory = location.directory;
      let stored;
      try { stored = B.readRegular(path.join(directory, "manifest.json"), B.LIMITS.manifestBytes); }
      catch (error) { throw new Error(`Missing or damaged ${managerId}/${arch} bundle. Run scripts/stage-native-runtimes.cjs with a pinned artifact inventory before packaging. ${error.message}`); }
      const manifest = JSON.parse(stored.bytes), pin = manager.core.catalog.find(item => item.version === manifest.version);
      if (!pin) throw new Error(`${managerId} bundled version is outside its source catalog.`);
      const identities = require("./stage-native-runtimes.cjs").additionalSourceIdentities;
      if (!require("node:util").isDeepStrictEqual(identities(pin.additionalSources), identities(manifest.provenance?.additionalSources))) {
        throw new Error("Bundled runtime additional sources differ from the catalog pin.");
      }
      if (location.version && location.version !== manifest.version) throw new Error("Bundled runtime folder version differs from its manifest.");
      if (versions && !versions.includes(manifest.version)) continue;
      if (requiredOnly && !required.includes(manifest.version)) continue;
      B.validateManifest(manifest, { managerId, version: pin.version, upstreamRevision: pin.upstreamRevision, arch });
      require('./native-supplementals.cjs').validatePublicMetadata(manifest);
      B.verifyPayload(path.join(directory, "files"), manifest);
      if (!B.versionAtLeast(maximumMacOS, manifest.minimumMacOS)) throw new Error(`${managerId}/${arch} needs macOS ${manifest.minimumMacOS}, above release target ${maximumMacOS}. Rebuild its dependency closure; keep the launcher minimum unchanged.`);
      if (signingIdentity && manifest.signature?.identity !== signingIdentity) throw new Error(`${managerId}/${arch} was signed with '${manifest.signature?.identity || "unknown"}', not '${signingIdentity}'. Restage before signing the launcher.`);
      if (process.platform === "darwin") {
        let observedMinimum = "0.0";
        for (const file of manifest.files.filter(file => file.architectures)) {
          const executable = path.join(directory, "files", file.path);
          const minimum = inspectCommands(executable).minimumMacOS;
          if (B.versionAtLeast(minimum, observedMinimum)) observedMinimum = minimum;
          verifySignature(executable);
        }
        if (!B.versionAtLeast(manifest.minimumMacOS, observedMinimum) || !B.versionAtLeast(observedMinimum, manifest.minimumMacOS)) throw new Error(`${managerId}/${arch} manifest minimum macOS does not match its real dependency load commands.`);
      }
      if (!seen.has(pin.version)) results.push({ managerId, version: pin.version, arch, minimumMacOS: manifest.minimumMacOS,
        bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), manifestSha256: stored.sha256,
        directoryRelative: path.relative(resourceRoot, directory).split(path.sep).join("/") });
      seen.add(pin.version);
      }
      if (!seen.size || required.some(version => !seen.has(version))) throw new Error(`Missing required ${managerId}/${arch} versions: ${required.filter(version => !seen.has(version)).join(", ") || "selected version"}.`);
      }
    }
  }
  if (selected.length && !results.length) throw new Error("No native packages support the selected launcher architectures.");
  if (!managerIds) {
    const S = require("./native-supplementals.cjs");
    for (const arch of architectures) S.verifySupplementals({ resourceRoot, arch, maximumMacOS, dependencies });
  }
  return results;
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || !args[index + 1]) throw new Error("Usage: node scripts/verify-native-runtimes.cjs [--root <native-runtimes>] [--arch arm64,x64] [--only id,id] [--maximum-macos 13.0] [--sign-identity <identity>]");
    options[args[index].slice(2)] = args[index + 1];
  }
  for (const result of verifyPackages({ resourceRoot: options.root && path.resolve(options.root), architectures: options.arch?.split(","),
    managerIds: options.only?.split(","), versions: options.versions?.split(","), requiredOnly: options["required-only"] === "true",
    maximumMacOS: options["maximum-macos"] || "13.0", signingIdentity: options["sign-identity"] })) console.log(JSON.stringify(result));
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { sourceOnlyManagers, bundleDirectories, distributionArchitectures, verifyPackages, main };
