const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../shared/runtime/bundled-native");
const NativeAbi = require("./native-abi");

/** Called after full selected-payload verification, for application/service
 * execution only. Metadata and device enumeration do not acquire an image. */
async function prepare({ payload, context, nativeAbi = NativeAbi.ARM64 }, dependencies = {}) {
  context.signal?.throwIfAborted();
  if (nativeAbi !== NativeAbi.ARM64) return null;
  const relative = "native/bionic/profile.json", file = path.join(payload.root, relative);
  try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const stored = Bundled.readRegular(path.join(payload.root, "runtime.json"), Bundled.LIMITS.manifestBytes);
  if (stored.sha256 !== payload.runtimeIdentity?.manifestSha256)
    throw new Error("The selected Android runtime metadata changed. Reinstall this version in Runtimes.");
  const manifest = JSON.parse(stored.bytes);
  const member = (name, maximum) => {
    Bundled.relativeFile(name);
    const record = manifest.files?.find(item => item.path === name);
    if (!record) throw new Error("The selected Android runtime preparation helper is missing. Reinstall this version in Runtimes.");
    const actual = Bundled.readRegular(path.join(payload.root, name), maximum);
    if (actual.sha256 !== record.sha256 || actual.size !== record.size || actual.mode !== record.mode)
      throw new Error("The selected Android runtime preparation files changed. Reinstall this version in Runtimes.");
    return actual;
  };
  // Unlisted files do not add requirements to a previously selected version.
  if (!manifest.files?.some(item => item.path === relative)) return null;
  const profile = JSON.parse(member(relative, 16384).bytes);
  if (profile.schemaVersion !== 1 || profile.nativeAbi !== NativeAbi.ARM64)
    throw new Error("The selected Android native profile is unsupported.");
  const { acquisition: image, content: expected, extractor } = profile.systemImage || {};
  const prepareImage = dependencies.prepareImage || require("./system-image").prepare;
  const options = { context, image, expected };
  // Earlier profiles can keep using an already acquired original. New image
  // acquisition always requires this selected payload's own verified helper.
  const cached = await prepareImage({ ...options, existingOnly: true }, dependencies.imageDependencies);
  if (cached) return cached;
  if (typeof extractor !== "string" || !extractor.startsWith("native/bionic/"))
    throw new Error("This Android runtime does not include system image preparation. Select a newer build in Runtimes.");
  const helper = member(extractor, Bundled.LIMITS.fileBytes);
  if (!(helper.mode & 0o111)) throw new Error("The selected Android system image helper is not executable.");
  return prepareImage({ ...options, extractor: path.join(payload.root, extractor) }, dependencies.imageDependencies);
}

module.exports = { prepare };
