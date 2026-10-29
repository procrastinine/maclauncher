const Included = require("../../shared/runtime/included-helpers");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const B = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const declarations = require("./distribution-supplementals.json");
const run = promisify(execFile), signatures = new Map();
const VERSION = "1.0.0", MAXIMUM = 64 * 1024 * 1024;
let hostVersion;

async function resolveHelper({ resourcesRoot, helperVersion = VERSION, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) throw new Error("Encrypted KIF tools require an Apple Silicon or Intel Mac.");
  const pin = (dependencies.declarations || declarations).find(item => item.id === "catsystem2-kif-crypto" && item.version === helperVersion);
  if (!pin) throw new Error("This app build has no KIF helper for the selected version.");
  const included = Included.resolveIncluded(dependencies.declarations || declarations, { id: pin.id, version: pin.version, arch, resourcesRoot });
  if (included) {
    const { directory } = included;
    B.verifyPayload(directory, pin);
    const record = JSON.parse(B.readRegular(path.join(directory, pin.manifestRelative), B.LIMITS.manifestBytes).bytes);
    const executable = pin.files.find(file => file.path === "kif-crypto"), executablePath = path.join(directory, executable.path);
    if (record.schemaVersion !== 1 || record.id !== pin.id || record.version !== pin.version || record.protocolVersion !== "KBF1" ||
        record.scope !== "kif-little-endian-blowfish" || record.sourceSha256 !== pin.sourceSha256 || record.binarySha256 !== executable.sha256 ||
        record.minimumMacOS !== pin.minimumMacOS || record.sourceKind !== "owned-source" || record.verifiedBuild !== true || record.build?.signing !== "ad-hoc" ||
        JSON.stringify(record.architectures) !== JSON.stringify(executable.architectures) ||
        JSON.stringify(Native.readMachOArchitectures(executablePath).sort()) !== JSON.stringify(executable.architectures.slice().sort()))
      throw new Error("The Included KIF helper's version or source identity changed.");
    const systemVersion = dependencies.systemVersion ? await dependencies.systemVersion() : hostVersion ||= (await run("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10000 })).stdout.trim();
    if (!B.versionAtLeast(systemVersion, pin.minimumMacOS)) throw new Error(`Encrypted KIF tools require macOS ${pin.minimumMacOS}.`);
    const signatureKey = B.fileIdentity(executablePath);
    if (signatures.get(executablePath) !== signatureKey) {
      await (dependencies.verifySignature || (file => run("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 10000, maxBuffer: 128 * 1024 })))(executablePath);
      if (signatures.size >= 16) signatures.delete(signatures.keys().next().value);
      signatures.set(executablePath, signatureKey);
    }
    return Object.freeze({ version: pin.version, executablePath, binarySha256: executable.sha256,
      sourceSha256: pin.sourceSha256, manifestSha256: pin.manifestSha256, minimumMacOS: pin.minimumMacOS, shared: true });
  }
  throw new Error("The included KIF helper is missing. Reinstall MacLauncher.");
}

function transform(helper, key, bytes, { encrypt = false, signal, spawnChild = spawn } = {}) {
  if (!helper?.executablePath || !Buffer.isBuffer(key) || key.length < 4 || key.length > 56 || !Buffer.isBuffer(bytes) || bytes.length > MAXIMUM || bytes.length % 8)
    return Promise.reject(new Error("Invalid bounded KIF cipher request."));
  signal?.throwIfAborted();
  const header = Buffer.alloc(16); header.write("KBF1"); header.writeUInt32LE(key.length, 4); header.writeUInt32LE(bytes.length, 8); header.writeUInt32LE(encrypt ? 1 : 0, 12);
  return new Promise((resolve, reject) => {
    // The key travels only on stdin. Child arguments, errors and logs never
    // contain KEY_CODE, V_CODE2, TOC seeds or archive file keys.
    const child = spawnChild(helper.executablePath, [], { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, ...(signal ? { signal } : {}) });
    let size = 0, settled = false; const chunks = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("The KIF cipher helper timed out.")); }, 15000);
    function finish(error, result) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
    child.on("error", () => finish(new Error("The Included KIF cipher helper could not start.")));
    child.stdin.on("error", () => finish(new Error("The KIF cipher request was interrupted.")));
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > bytes.length) { child.kill("SIGKILL"); finish(new Error("The KIF cipher helper exceeded its output limit.")); return; }
      chunks.push(chunk);
    });
    child.on("close", code => code === 0 && size === bytes.length ? finish(null, Buffer.concat(chunks)) : finish(new Error("The KIF cipher helper rejected the data.")));
    child.stdin.write(header); child.stdin.write(key); child.stdin.end(bytes);
  });
}

module.exports = { VERSION, MAXIMUM, resolveHelper, transform };
