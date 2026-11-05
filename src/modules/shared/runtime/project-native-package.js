const fs = require("node:fs"), path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Catalog = require("./maclauncher-builds"), Bundled = require("./bundled-native");

async function extractArchive(archive, destination, signal) {
    const options = { ...(signal ? {signal} : {}), timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
    const listed = await execute("/usr/bin/tar", ["-tf", archive], options), names = new Set();
    for (const original of listed.stdout.split("\n").filter(Boolean)) {
      const name = original.replace(/^\.\//, "").replace(/\/$/, "");
      if (!name) continue;
      Bundled.relativeFile(name);
      if (names.has(name) || names.size >= Bundled.LIMITS.files * 2)
        throw new Error("The hosted runtime archive layout is invalid.");
      names.add(name);
    }
    const types = await execute("/usr/bin/tar", ["-tvf", archive], options);
    if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line)))
      throw new Error("The hosted runtime archive contains unsupported links.");
    await execute("/usr/bin/tar", ["-xf", archive, "-C", destination], options);
  }

// Each record identifies its source revision and carries the capabilities
// modules read. A record without `source` uses the same-version launcher build
// recipe, or the revision recorded when it was installed.
function createProjectNativePackage({ projectId, repository, validateManifest, launcherContract = 2 }, { id, catalog, nativeLibrary = false, dependencies = {} }) {
  if (projectId !== id) throw new Error("The hosted runtime project must match its native manager.");
  Catalog.catalogUrl({ projectId, repository });
  const recipes = new Map(catalog.filter(pin => !pin.deprecated).map(pin => [pin.version, pin]));
  const options = { projectId, repository, launcherContract };
  function executionFiles(files, record) {
    // The sealed manager manifest records binary slices. The archive wrapper
    // also identifies native files executed/loaded by its Intel child process.
    // Legacy inventories can omit that derived role on either side.
    const intelChild = !nativeLibrary && record.arch === "x64" &&
      record.launcherArchitectures.includes("arm64") && record.launcherArchitectures.includes("x64");
    return files.map(file => intelChild && file.architectures?.includes("x86_64") &&
      file.format !== "pe" && !Object.hasOwn(file, "executionArchitecture")
      ? { ...file, executionArchitecture: "x86_64" } : file);
  }
  function recordFor(pin) {
    const record = Catalog.validateProjectRecord(pin.projectPackage, options);
    return record;
  }
  function inspect(root, pin, {userDataDir,verification="status",resolveDependency,installedDependencies,metadataOnly=false} = {}) {
    const record = recordFor(pin), P=require('./package-dependencies');
    const parent=path.dirname(root),wrapper=path.join(parent,fs.existsSync(path.join(parent,'project-package.json'))?'project-package.json':'runtime-package.json');
    const outer=fs.existsSync(wrapper)?JSON.parse(Bundled.readRegular(wrapper,Bundled.LIMITS.manifestBytes).bytes):null;
    if(outer&&!installedDependencies)installedDependencies=P.load(userDataDir || (outer.dependencies?.length?P.userDataForPayload(root):undefined),outer.dependencies,{verification:'status'});
    resolveDependency ||= P.resolver(installedDependencies||new Map());
    // Lazy import keeps the shared pinned-manager dependency acyclic at load.
    const selected = require("./project-build-manager").inspectPackage(root, record, {
      projectId, manifestRelative: record.manifestRelative, sourceRelative: null, filesPrefix: "files/", resolveDependency, declaration:outer,metadataOnly,managed:true,
      executableRelative: manifest => manifest.executableRelative,
      validateManifest(manifest) {
        Bundled.validateRuntimeManifest(manifest, { managerId: id, version: pin.version, arch: record.arch });
        validateManifest?.(manifest, pin);
      }
    });
    selected.declaration.files = executionFiles(selected.declaration.files, record);
    if(outer){
      const logical={...selected.declaration,files:executionFiles(selected.declaration.files,record)};
      selected.declaration=P.bind(root,record,logical,resolveDependency,wrapper,{normalizeFiles:files=>executionFiles(files,record)});
    }
    selected.dependencyLibraryPaths=P.loaderPaths(selected.declaration,installedDependencies||new Map());
    selected.dependencyReadRoots=P.readRoots(installedDependencies||new Map());
    return P.attach(selected,{resolveDependency,sealedDeclaration:outer});
  }
  function inspectInstalled(directory, pin, { verification = "full", userDataDir } = {}) {
    const selected = inspect(path.join(directory, "project-payload"), pin, {verification,userDataDir});
    if (verification === "full") Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
    return selected;
  }
  // Each record is listed: usable, or with the reason this launcher cannot install it.
  function supported(value) {
    const unavailable = [...value.unavailable || []];
    const usable = value.packages.flatMap(record => {
      const recipe = recipes.get(record.version), upstreamRevision = record.source?.revision || record.asset.sha256;
      return [{ ...recipe, ...record.capabilities, ...record, upstreamRevision, asset: record.asset, projectPackage: record, localBuild: false,
        architecture: record.arch === "x64" ? "x86_64" : record.arch,
        hostArchitectures: record.launcherArchitectures, minimumMacOS: record.minimumMacOS,
        installReason: undefined }];
    });
    return [...usable, ...Catalog.unavailablePins(projectId,
      unavailable.map(row => ({ ...row, upstreamRevision: recipes.get(row.version)?.upstreamRevision })))];
  }
  async function discover({ signal }) {
    return supported(await Catalog.fetchProjectCatalog({ ...options, signal }, dependencies));
  }

  async function prepare({ unpacked, pin, signal, userDataDir, resolveDependency, installedDependencies }) {
    signal?.throwIfAborted();
    const record = recordFor(pin);
    const wrapperBytes = Bundled.readRegular(path.join(unpacked, "runtime-package.json"), Bundled.LIMITS.manifestBytes);
    const wrapper = Bundled.managedDeclaration(JSON.parse(wrapperBytes.bytes)), P=require('./package-dependencies');
    const selected = inspect(path.join(unpacked,"files"),pin,{userDataDir,resolveDependency,installedDependencies,verification:'status',metadataOnly:true});
    // Before the transport rename, bind the unchanged wrapper explicitly.
    selected.declaration=P.bind(selected.root,record,selected.declaration,resolveDependency,path.join(unpacked,'runtime-package.json'),{normalizeFiles:files=>executionFiles(files,record)});
    P.attach(selected,{resolveDependency,sealedDeclaration:wrapper});
    if(wrapper.aliases)Bundled.verifyStoredPayload(selected.root,wrapper,{managed:true});
    P.materialize(selected.root,wrapper,resolveDependency,{verify:false});
    Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
    if (dependencies.verifySignatures) await dependencies.verifySignatures(selected.payloadRoot, selected.manifest, { signal });
    else await Bundled.verifySignatures(selected.root,selected.declaration,{signal});
    fs.renameSync(path.join(unpacked, "files"), path.join(unpacked, "project-payload"));
    fs.renameSync(path.join(unpacked, "runtime-package.json"), path.join(unpacked, "project-package.json"));
    const relative = value => path.posix.join("project-payload",path.relative(selected.root,selected.payloadRoot).split(path.sep).join('/'),Bundled.relativeFile(value));
    return { manifestSha256: record.manifestSha256,
      sourceIdentity: Catalog.sourceIdentity(record, {manifest: selected.manifest, wrapper, receiptRevision: pin.upstreamRevision}),
      environmentRelative: Object.fromEntries(Object.entries(selected.manifest.environmentRelative || {}).map(([key, value]) => [key, relative(value)])),
      runtimeFiles: Object.fromEntries(Object.entries(selected.manifest.runtimeFiles || {}).map(([key, value]) => [key, relative(value)])) };
  }
  return { discover, extract: extractArchive, prepare, inspectInstalled, inspect };
}

module.exports = { createProjectNativePackage, extractArchive };
