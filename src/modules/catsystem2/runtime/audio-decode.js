const Included = require("../../shared/runtime/included-helpers");
const fs = require("node:fs"), path = require("node:path");
const { spawn, execFile } = require("node:child_process"), { promisify } = require("node:util");
const B = require("../../shared/runtime/bundled-native"), Native = require("../../shared/runtime/local-native");
const declarations = require("./distribution-supplementals.json"), run = promisify(execFile);
const VERSION = "1.0.0-ml1", LIMITS = Object.freeze({ inputBytes: 64 * 1024 * 1024, pcmBytes: 256 * 1024 * 1024, seconds: 600, timeoutMs: 30000 });
const signatures = new Map(); let hostVersion;

async function resolveHelper({ resourcesRoot, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) throw new Error("Ogg/Vorbis decoding requires an Apple Silicon or Intel Mac.");
  const pin = (dependencies.declarations || declarations).find(item => item.id === "catsystem2-ogg-decode" && item.version === VERSION);
  if (!pin) throw new Error("This app has no included Ogg/Vorbis decoder for this format.");
  const included = Included.resolveIncluded(dependencies.declarations || declarations, { id: pin.id, version: pin.version, arch, resourcesRoot });
  if (included) {
    const { directory } = included;
    B.verifyPayload(directory, pin); const record = JSON.parse(B.readRegular(path.join(directory, pin.manifestRelative), B.LIMITS.manifestBytes).bytes);
    const binary = pin.files.find(file => file.path === "ogg-decode"), executablePath = path.join(directory, "ogg-decode");
    if (!binary || record.schemaVersion !== 1 || record.id !== pin.id || record.version !== VERSION || record.protocolVersion !== 1 ||
        record.sourceKind !== "owned-source-with-bsd-codecs" || record.sourceSha256 !== pin.sourceSha256 || record.binarySha256 !== binary.sha256 ||
        record.minimumMacOS !== pin.minimumMacOS || record.build?.signing !== "ad-hoc" || JSON.stringify(record.architectures) !== JSON.stringify(binary.architectures) ||
        record.dependencySources?.length !== 2 || record.dependencySources[0]?.sha256 !== "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061" ||
        record.dependencySources[1]?.sha256 !== "b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b" ||
        JSON.stringify(Native.readMachOArchitectures(executablePath).sort()) !== JSON.stringify(binary.architectures.slice().sort()))
      throw new Error("The included Ogg/Vorbis decoder's source, version or CPU identity changed.");
    const current = dependencies.systemVersion ? await dependencies.systemVersion() : hostVersion ||= (await run("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10000 })).stdout.trim();
    if (!B.versionAtLeast(current, pin.minimumMacOS)) throw new Error(`Ogg/Vorbis decoding requires macOS ${pin.minimumMacOS}.`);
    const identity = B.fileIdentity(executablePath);
    if (signatures.get(executablePath) !== identity) {
      await (dependencies.verifySignature || (file => run("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 10000, maxBuffer: 128 * 1024 })))(executablePath);
      if (signatures.size >= 16) signatures.delete(signatures.keys().next().value); signatures.set(executablePath, identity);
    }
    return Object.freeze({ version: VERSION, protocolVersion: 1, executablePath, binarySha256: binary.sha256, sourceSha256: pin.sourceSha256, manifestSha256: pin.manifestSha256, minimumMacOS: pin.minimumMacOS, shared: true });
  }
  throw new Error("The included Ogg/Vorbis decoder is missing.");
}

function inspectPcm(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > LIMITS.pcmBytes + 32 || bytes.toString("ascii", 0, 4) !== "MLPC" || bytes.readUInt32LE(4) !== 1 || bytes.readUInt32LE(28) !== 0)
    throw new Error("The decoded audio protocol is invalid.");
  const channels = bytes.readUInt32LE(8), sampleRate = bytes.readUInt32LE(12), frames = bytes.readBigUInt64LE(16), size = bytes.readUInt32LE(24);
  if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || frames < 1n || frames > BigInt(sampleRate * LIMITS.seconds) ||
      frames * BigInt(channels * 2) !== BigInt(size) || size > LIMITS.pcmBytes || bytes.length !== size + 32) throw new Error("Decoded audio dimensions or length disagree.");
  return { channels, sampleRate, frames: Number(frames), pcm: bytes.subarray(32) };
}

function decodeOgg(helper, bytes, { signal, spawnChild = spawn } = {}) {
  if (helper?.version !== VERSION || helper.protocolVersion !== 1 || !path.isAbsolute(helper.executablePath || "") || !Buffer.isBuffer(bytes) || bytes.length < 27 || bytes.length > LIMITS.inputBytes || bytes.toString("ascii", 0, 4) !== "OggS")
    return Promise.reject(new Error("A bounded original Ogg/Vorbis stream and exact decoder are required."));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnChild(helper.executablePath, ["--decode"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, ...(signal ? { signal } : {}) });
    let size = 0, failure = null, settled = false; const chunks = [];
    const timer = setTimeout(() => { failure ||= new Error("Ogg/Vorbis decoding timed out."); child.kill("SIGKILL"); }, LIMITS.timeoutMs);
    child.on("error", () => { failure ||= new Error("The Ogg/Vorbis decoder could not start."); });
    child.stdin.on("error", () => { failure ||= new Error("Ogg/Vorbis input was interrupted."); child.kill("SIGKILL"); });
    child.stderr.resume(); child.stdout.on("data", chunk => {
      size += chunk.length; if (size > LIMITS.pcmBytes + 32) { failure ||= new Error("Decoded audio exceeds its byte limit."); child.kill("SIGKILL"); return; } chunks.push(chunk);
    });
    child.on("close", code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (signal?.aborted) { try { signal.throwIfAborted(); } catch (error) { return reject(error); } }
      if (failure) return reject(failure); if (code !== 0) return reject(new Error("Ogg/Vorbis audio is corrupt or unsupported."));
      try { signal?.throwIfAborted(); resolve(inspectPcm(Buffer.concat(chunks))); } catch (error) { reject(error); }
    });
    child.stdin.end(bytes);
  });
}

function wave(decoded) {
  if (![1, 2].includes(decoded?.channels) || !Number.isInteger(decoded.sampleRate) || decoded.sampleRate < 8000 || decoded.sampleRate > 192000 || !Number.isSafeInteger(decoded.frames) || decoded.frames < 1 || decoded.frames > decoded.sampleRate * LIMITS.seconds || !Buffer.isBuffer(decoded.pcm) || decoded.pcm.length !== decoded.frames * decoded.channels * 2 || decoded.pcm.length > LIMITS.pcmBytes)
    throw new Error("Bounded decoded audio is required for a WAVE cache.");
  const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(decoded.pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(decoded.channels, 22); header.writeUInt32LE(decoded.sampleRate, 24); header.writeUInt32LE(decoded.sampleRate * decoded.channels * 2, 28);
  header.writeUInt16LE(decoded.channels * 2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(decoded.pcm.length, 40); return Buffer.concat([header, decoded.pcm]);
}
module.exports = { VERSION, LIMITS, resolveHelper, inspectPcm, decodeOgg, wave };
