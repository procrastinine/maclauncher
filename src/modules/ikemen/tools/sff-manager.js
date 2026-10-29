const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager, hashFile } = require("../../shared/runtime/pinned-native-manager");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const { downloadToFile } = require("../../shared/runtime/download-utils");

const SOURCE = "https://github.com/openkakutou/sff";
function verify(file, artifact, { requireDigest = true } = {}) {
  const stat = fs.lstatSync(file);
  const sha256 = hashFile(file);
  if (!artifact || requireDigest && !/^[a-f0-9]{64}$/.test(artifact.sha256 || "") ||
      !stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes || artifact.sha256 && sha256 !== artifact.sha256)
    throw new Error("SFF Tools files do not match the selected upstream release.");
  return { ...artifact, sha256 };
}
function inspectRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) {
  const sha256 = hashFile(runtimePath);
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("SFF Tools module changed.");
  const fd = fs.openSync(runtimePath, "r"), magic = Buffer.alloc(8);
  try { fs.readSync(fd, magic, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!magic.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error("SFF Tools module is not WebAssembly v1.");
  return { executablePath: runtimePath, architectures: ["wasm"], needsRosetta: false, sha256, runtimeVersion, upstreamRevision };
}
function mapRelease(release, { resolveRevision, githubAssetDigest, sourceUrl }) {
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "")?.[1];
  const asset = release.assets?.find(item => item.name === "sff.wasm"), glue = release.assets?.find(item => item.name === "wasm_exec.js");
  const officialAsset = (item, filename, maxBytes, minimumBytes = 1) => {
    if (!item || item.browser_download_url !== SOURCE + "/releases/download/" + release.tag_name + "/" + filename ||
        !Number.isSafeInteger(item.size) || item.size < minimumBytes || item.size > maxBytes) return null;
    const sha256 = githubAssetDigest(item);
    if (!sha256 && (!Number.isSafeInteger(item.id) || item.id < 1)) return null;
    return { filename, url: item.browser_download_url, bytes: item.size,
      ...(sha256 ? { sha256 } : { integrity: "recorded-local", assetId: item.id }) };
  };
  const wasm = officialAsset(asset, "sff.wasm", 32 * 1024 ** 2, 8), runtimeGlue = officialAsset(glue, "wasm_exec.js", 1024 ** 2);
  if (!version || !wasm || !runtimeGlue) return null;
  return Promise.resolve(resolveRevision(release)).then(upstreamRevision => ({ version, upstreamRevision, sourceUrl, localBuild: false,
    asset: wasm, glue: runtimeGlue }));
}
function createManager(dependencies = {}) {
  const core = createPinnedNativeManager({ id: "sff-tools", label: "SFF Tools", catalog: [], supportsDefault: true,
    discoverCatalog: createGithubReleaseDiscovery({ owner: "openkakutou", repo: "sff", mapRelease, dependencies }),
    sourceUrl: SOURCE, resolveExecutable: root => path.join(root, "sff.wasm"), inspectRuntime,
    dependencies: { ...dependencies, extractArchive: async (archive, root) => fs.copyFileSync(archive, path.join(root, "sff.wasm")) },
    prepareInstall: async ({ unpacked, pin, signal, onProgress }) => {
      if (!pin.glue || pin.glue.filename !== "wasm_exec.js") throw new Error("Refresh SFF Tools versions to obtain its matching runtime glue.");
      const file = path.join(unpacked, pin.glue.filename);
      await (dependencies.downloadToFile || downloadToFile)(pin.glue.url, file, { signal, onProgress });
      const runtimeGlue = verify(file, pin.glue, { requireDigest: false });
      for (const name of ["sff-MIT.txt", "Go-BSD.txt"]) fs.copyFileSync(path.join(__dirname, "licenses", name), path.join(unpacked, name));
      return { runtimeGlue, sourceRevision: pin.upstreamRevision, licenses: ["sff-MIT.txt", "Go-BSD.txt"] };
    } });
  function verifyInstall(install) {
    if (!install) return null;
    try {
      const glue = install.installationMetadata?.runtimeGlue;
      if (glue?.filename !== "wasm_exec.js") return null;
      verify(path.join(install.installDir, glue.filename), glue); return install;
    } catch { return null; }
  }
  return { ...core,
    resolveSelection(...args) {
      const selected = core.resolveSelection(...args), install = verifyInstall(selected.install);
      return { ...selected, install, ready: Boolean(install), reason: install ? null : selected.reason || "SFF Tools runtime glue changed. Reinstall the selected version." };
    },
    getState(options) {
      const state = core.getState(options), installed = state.installed.map(install => verifyInstall(install) ? install : { ...install, ready: false });
      return { ...state, installed, sections: state.sections.map(section => ({ ...section, installed })) };
    },
    __test: { mapRelease, verifyInstall }
  };
}
module.exports = { manager: createManager(), createManager, inspectRuntime };
