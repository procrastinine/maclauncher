const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager, hashFile } = require("../../shared/runtime/pinned-native-manager");
const Upstream = require("../../shared/runtime/upstream");

const SOURCE = "https://github.com/openkakutou/sff";
// The installed glue matches the size and SHA-256 recorded at install.
function verify(file, artifact) {
  const stat = fs.lstatSync(file);
  if (!/^[a-f0-9]{64}$/.test(artifact?.sha256 || "") || !stat.isFile() || stat.isSymbolicLink() ||
      artifact.bytes !== undefined && stat.size !== artifact.bytes || hashFile(file) !== artifact.sha256)
    throw new Error("SFF Tools files do not match the selected upstream release.");
}
function inspectRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) {
  const sha256 = hashFile(runtimePath);
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("SFF Tools module changed.");
  const fd = fs.openSync(runtimePath, "r"), magic = Buffer.alloc(8);
  try { fs.readSync(fd, magic, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!magic.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error("SFF Tools module is not WebAssembly v1.");
  return { executablePath: runtimePath, architectures: ["wasm"], needsRosetta: false, sha256, runtimeVersion, upstreamRevision };
}
// The module and its Go glue keep their current names when present; a renamed
// release is read by file type. The glue is listed with the module's release,
// and installed copies use the names the worker loads.
function recognize(release) {
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "")?.[1];
  if (!version) return null;
  const named = (current, pattern) => release.assets?.find(item => item.name === current) ||
    release.assets?.find(item => pattern.test(item?.name || "") && !/debug|symbols/i.test(item.name));
  const wasm = named("sff.wasm", /\.wasm$/i), glue = named("wasm_exec.js", /wasm_exec[^/]*\.js$/i);
  if (!wasm || !glue) return { version, installReason: "This release has no WebAssembly module with its Go runtime glue." };
  const digest = Upstream.githubDigest(glue);
  return { version, assets: [wasm], details: { glue: { filename: glue.name, url: glue.browser_download_url,
    ...(Number.isSafeInteger(glue.size) && glue.size > 0 ? { bytes: glue.size } : {}), ...(digest?.algorithm === "sha256" ? { sha256: digest.value } : {}) } } };
}
const upstream = Upstream.github({ repository: "openkakutou/sff", recognize });
function createManager(dependencies = {}) {
  const core = createPinnedNativeManager({ id: "sff-tools", label: "SFF Tools", supportsDefault: true, upstream,
    sourceUrl: SOURCE, resolveExecutable: root => path.join(root, "sff.wasm"), inspectRuntime,
    dependencies: { ...dependencies, extractArchive: async (archive, root) => fs.copyFileSync(archive, path.join(root, "sff.wasm")) },
    prepareInstall: async ({ unpacked, pin, signal, onProgress }) => {
      const listed = pin.glue && Upstream.listedFile(pin.glue);
      if (!listed) throw new Error("Refresh SFF Tools versions to obtain its matching runtime glue.");
      const file = path.join(unpacked, "wasm_exec.js"), fetched = await upstream.download(listed, file, { signal, onProgress });
      const runtimeGlue = { ...pin.glue, filename: "wasm_exec.js", bytes: fetched.bytes, sha256: fetched.sha256 };
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
    __test: { recognize, verifyInstall }
  };
}
module.exports = { manager: createManager(), createManager, inspectRuntime };
