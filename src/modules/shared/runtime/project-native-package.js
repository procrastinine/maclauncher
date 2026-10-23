const fs = require("node:fs"), path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Catalog = require("./maclauncher-builds"), Bundled = require("./bundled-native");

// Module pins define supported source/ABI profiles. A hosted binary supplies
// those profiles without invoking the module's upstream source-build recipe.
function createProjectNativePackage({ projectId, repository, validateManifest }, { id, catalog, dependencies = {} }) {
  if (projectId !== id) throw new Error("The hosted runtime project must match its native manager.");
  Catalog.catalogUrl({ projectId, repository });
  const pins = new Map(catalog.map(pin => [pin.version, pin]));
  const options = { projectId, repository, architecture: process.arch };
  function recordFor(pin) {
    const record = Catalog.validateProjectCatalog({ schemaVersion: 2, projectId, updatePolicy: "manual", packages: [pin.projectPackage] }, options).packages[0];
    const original = pins.get(record?.version);
    if (!original || original.deprecated || original.upstreamRevision !== pin.upstreamRevision ||
        original.sourceArtifact && original.sourceArtifact.sha256 !== record.sourceSha256)
      throw new Error("The hosted runtime differs from its supported source profile.");
    return record;
  }
  function inspect(root, pin) {
    const record = recordFor(pin);
    // Lazy import keeps the shared pinned-manager dependency acyclic at load.
    return require("./project-build-manager").inspectPackage(root, record, {
      projectId, manifestRelative: record.manifestRelative, sourceRelative: null, filesPrefix: "files/",
      executableRelative: manifest => manifest.executableRelative,
      validateManifest(manifest) {
        Bundled.validateManifest(manifest, { managerId: id, version: pin.version,
          upstreamRevision: pin.upstreamRevision, arch: record.arch });
        const original = pins.get(pin.version);
        for (const key of ["sourceTreeSha256", "overlaySha256"])
          if (original[key] && manifest.provenance[key] !== original[key])
            throw new Error("The hosted runtime adaptation differs from its supported source profile.");
        validateManifest?.(manifest, original);
      }
    });
  }
  function inspectInstalled(directory, pin, { verification = "full" } = {}) {
    const selected = inspect(path.join(directory, "project-payload"), pin);
    if (verification === "full") Bundled.verifyPayload(selected.root, selected.declaration);
    return selected;
  }
  async function discover({ signal }) {
    const value = await Catalog.fetchProjectCatalog({ ...options, signal }, dependencies);
    return value.packages.flatMap(record => {
      const original = pins.get(record.version);
      if (!original || original.deprecated) return [];
      const pin = { ...original, asset: record.asset, projectPackage: record, localBuild: false,
        architecture: record.arch === "x64" ? "x86_64" : record.arch,
        hostArchitectures: record.launcherArchitectures, minimumMacOS: record.minimumMacOS,
        installReason: undefined };
      recordFor(pin);
      return [pin];
    });
  }
  async function extract(archive, destination, signal) {
    const options = { signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
    const listed = await execute("/usr/bin/tar", ["-tzf", archive], options), names = new Set();
    for (const original of listed.stdout.split("\n").filter(Boolean)) {
      const name = original.replace(/^\.\//, "").replace(/\/$/, "");
      if (!name) continue;
      Bundled.relativeFile(name);
      if (names.has(name) || names.size >= Bundled.LIMITS.files * 2 ||
          name !== "runtime-package.json" && name !== "files" && !name.startsWith("files/"))
        throw new Error("The hosted runtime archive layout is invalid.");
      names.add(name);
    }
    const types = await execute("/usr/bin/tar", ["-tvzf", archive], options);
    if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line)))
      throw new Error("The hosted runtime archive contains unsupported links.");
    await execute("/usr/bin/tar", ["-xzf", archive, "-C", destination], options);
  }
  async function prepare({ unpacked, pin, signal }) {
    signal?.throwIfAborted();
    const record = recordFor(pin);
    if (JSON.stringify(fs.readdirSync(unpacked).sort()) !== JSON.stringify(["files", "runtime-package.json"]))
      throw new Error("The hosted runtime archive layout is invalid.");
    const wrapperBytes = Bundled.readRegular(path.join(unpacked, "runtime-package.json"), Bundled.LIMITS.manifestBytes);
    const wrapper = JSON.parse(wrapperBytes.bytes), selected = inspect(path.join(unpacked, "files"), pin);
    if (["id", "version", "arch", "minimumMacOS", "manifestRelative", "manifestSha256", "sourceSha256"]
      .some(key => wrapper[key] !== record[key]) || JSON.stringify(wrapper.launcherArchitectures) !== JSON.stringify(record.launcherArchitectures) ||
      wrapper.redistribution === "local-only" || wrapper.sourceArtifact && wrapper.sourceArtifact.sha256 !== record.sourceSha256)
      throw new Error("The hosted runtime archive differs from its selected project or source identity.");
    const inventory = files => files.map(file => [file.path, file.size, file.mode, file.sha256,
      file.architectures?.slice().sort() || null]).sort((a, b) => a[0].localeCompare(b[0]));
    if (!Array.isArray(wrapper.files) || JSON.stringify(inventory(wrapper.files)) !== JSON.stringify(inventory(selected.declaration.files)))
      throw new Error("The hosted runtime archive inventory differs from its sealed manifest.");
    Bundled.verifyPayload(selected.root, selected.declaration);
    if (dependencies.verifySignatures) await dependencies.verifySignatures(selected.payloadRoot, selected.manifest, { signal });
    else for (const file of selected.manifest.files.filter(file => file.architectures))
      await execute("/usr/bin/codesign", ["--verify", "--strict", path.join(selected.payloadRoot, file.path)],
        { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    fs.renameSync(path.join(unpacked, "files"), path.join(unpacked, "project-payload"));
    fs.renameSync(path.join(unpacked, "runtime-package.json"), path.join(unpacked, "project-package.json"));
    const relative = value => path.posix.join("project-payload/files", value);
    return { manifestSha256: record.manifestSha256,
      environmentRelative: Object.fromEntries(Object.entries(selected.manifest.environmentRelative || {}).map(([key, value]) => [key, relative(value)])),
      runtimeFiles: Object.fromEntries(Object.entries(selected.manifest.runtimeFiles || {}).map(([key, value]) => [key, relative(value)])) };
  }
  return { discover, extract, prepare, inspectInstalled, inspect };
}

module.exports = { createProjectNativePackage };
