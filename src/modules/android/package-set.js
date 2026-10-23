const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { inspectApk, withApk, LIMITS } = require("./apk");
const Manifest = require("./binary-manifest");
const ARCHIVES = /\.(?:xapk|apkm|apks)$/i;
const MAX_APKS = 64;

// Android installers retain the manifest split identity in the installed path.
// Native clients also use this path to distinguish asset packs from config APKs.
function installedName(split) {
  return split == null ? "base.apk" : "split_" + encodeURIComponent(split) + ".apk";
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Android packages must be regular files.");
  return stat;
}

function folderFiles(directory) {
  const files = [], entries = fs.opendirSync(directory);
  try {
    let item, count = 0;
    while ((item = entries.readSync())) {
      if (++count > 4096) throw new Error("The Android package folder contains too many files.");
      if (!/\.apk$/i.test(item.name)) continue;
      if (!item.isFile() || item.isSymbolicLink()) throw new Error("Android packages must be regular files.");
      files.push(path.join(directory, item.name));
      if (files.length > MAX_APKS) throw new Error("An Android package set can contain at most 64 APKs.");
    }
  } finally { entries.closeSync(); }
  if (!files.length) throw new Error("The folder contains no Android APK files.");
  return files.sort();
}

function directFiles(input) {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error("Linked Android package inputs are unsupported.");
  if (stat.isDirectory()) return folderFiles(input);
  regular(input);
  if (!/\.apk$/i.test(input)) return null;
  const metadata = inspectApk(input);
  const required = metadata.split || metadata.requiresSplitInstallation || metadata.requiredSplits.length;
  let siblings;
  try { siblings = folderFiles(path.dirname(input)); }
  catch (error) { if (required) throw error; return [input]; }
  const matching = [];
  for (const file of siblings) {
    try {
      const m = inspectApk(file);
      if (m.packageName === metadata.packageName && m.versionCode === metadata.versionCode &&
          m.versionCodeMajor === metadata.versionCodeMajor) matching.push({ file, metadata: m });
    }
    catch { /* Unrelated invalid files do not become part of a selected APK. */ }
  }
  return required || matching.some(item => item.metadata.split) ? matching.map(item => item.file) : [input];
}

function plan(records, { verified = false, profile = {}, requireLauncher = true, inspection = false } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_APKS)
    throw new Error("An Android package set requires 1–64 APKs.");
  const bases = records.filter(item => item.metadata.split === null);
  if (bases.length !== 1) throw new Error("Select one Android base APK and its matching splits.");
  const nativeAbi = inspection ? null : require("./native-abi").supported(profile).find(abi => records.filter(item => item.metadata.split === null || item.metadata.isFeatureSplit).every(item => !item.metadata.architectures.length || item.metadata.architectures.includes(abi)) && (!records.some(item => item.metadata.architectures.length) || records.some(item => item.metadata.architectures.includes(abi))));
  if (!inspection && !nativeAbi) throw new Error("The Android package set does not include compatible ARM native libraries.");
  const base = bases[0], splits = new Map(), identities = new Set(); let sourceBytes = 0;
  const certificates = item => {
    if (!Array.isArray(item.signers) || !item.signers.length || item.signers.some(s => !/^[a-f0-9]{64}$/.test(s)))
      throw new Error("Android package signatures could not be verified.");
    return [...new Set(item.signers)].sort().join(",");
  };
  for (const item of records) {
    const m = item.metadata, b = base.metadata;
    for (const key of ["versionCode", "versionCodeMajor"])
      if (!(inspection && m[key] === null) && (!Number.isInteger(m[key]) || m[key] < 0 || m[key] > 0xffffffff))
        throw new Error("The Android package version is invalid.");
    if (m.packageName !== b.packageName || m.versionCode !== b.versionCode || m.versionCodeMajor !== b.versionCodeMajor)
      throw new Error("Android base and split APKs must have the same package and version.");
    if (verified && certificates(item) !== certificates(base)) throw new Error("Android base and split APKs have different signing certificates.");
    const stat = regular(item.file), identity = stat.dev + ":" + stat.ino;
    sourceBytes += stat.size;
    if (sourceBytes > LIMITS.extractedBytes) throw new Error("The Android package set exceeds the supported size.");
    if (!inspection && m.isFeatureSplit && m.architectures.length && !m.architectures.includes(nativeAbi))
      throw new Error("An Android feature split does not include " + nativeAbi + " native libraries.");
    if (identities.has(identity)) throw new Error("The Android package set contains the same file more than once.");
    identities.add(identity);
    if (m.split !== null) {
      if (typeof m.split !== "string" || !m.split || splits.has(m.split)) throw new Error("The Android package set contains duplicate split names.");
      splits.set(m.split, item);
    }
  }
  const selected = inspection ? records : records.filter(item => !item.metadata.architectures.length || item.metadata.architectures.includes(nativeAbi));
  if (!inspection && (!selected.includes(base) || records.some(item => item.metadata.architectures.length) &&
      !selected.some(item => item.metadata.architectures.includes(nativeAbi))))
    throw new Error("The Android package set does not include " + nativeAbi + " native libraries.");
  if (base.metadata.requiresSplitInstallation && selected.length === 1) throw new Error("The Android package requires additional split APKs.");
  const retained = new Set(selected), active = new Set(), done = new Set(), ordered = [base];
  function visit(item) {
    if (done.has(item)) return;
    if (active.has(item)) throw new Error("The Android package has cyclic split dependencies.");
    active.add(item);
    for (const name of [...item.metadata.requiredSplits, ...(item.metadata.configForSplit ? [item.metadata.configForSplit] : [])]) {
      const dependency = name === "base" ? base : splits.get(name);
      if (!dependency || !retained.has(dependency)) throw new Error("A required Android split APK is missing: " + name);
      if (dependency !== base || item === base) visit(dependency);
    }
    active.delete(item); done.add(item); if (item !== base) ordered.push(item);
  }
  for (const item of [base, ...selected.filter(item => item !== base).sort((a, b) => a.metadata.split.localeCompare(b.metadata.split))]) visit(item);
  const inspected = ordered.length === 1 ? base.metadata : { ...Manifest.parseBinaryManifestSet(ordered.map(item =>
    withApk(item.file, archive => archive.read("AndroidManifest.xml", Manifest.LIMITS.bytes)))), libraries: base.metadata.libraries };
  const metadata = { ...inspected, nativeAbi, splitApks: ordered.map(item => item.metadata.split),
    architectures: [...new Set(ordered.flatMap(item => item.metadata.architectures))].sort(),
    requiredGlEsVersion: Math.max(0, ...ordered.map(item => item.metadata.requiredGlEsVersion || 0)),
    dex: ordered.flatMap(item => item.metadata.dex), limitations: [] };
  if (requireLauncher && !metadata.launchers.length) metadata.limitations.push("The APK has no enabled launcher activity.");
  if (!metadata.dex.length && metadata.hasCode !== false)
    metadata.limitations.push("The Android package is missing its application bytecode.");
  return { base, selected: ordered, excluded: records.filter(item => !retained.has(item)), metadata };
}

function inspectFiles(files, { profile = {}, requireLauncher = true, inspection = false } = {}) { return plan(files.map(file => ({ file, metadata: inspectApk(file, { requireLauncher, ...(inspection ? {} : { nativeArchitectures: require("./native-abi").supported(profile) }) }) })), { profile, requireLauncher, inspection }); }

async function unpack(input, directory, signal) {
  const outputs = [];
  await withApk(input, async archive => {
    let apks = archive.entries.filter(entry => /\.apk$/i.test(entry.name));
    // bundletool may include mutually exclusive standalone/system variants.
    // Its split installation lives under splits/; never combine both variants.
    if (/\.apks$/i.test(input) && apks.some(entry => entry.name.startsWith("splits/")))
      apks = apks.filter(entry => entry.name.startsWith("splits/"));
    if (!apks.length || apks.length > MAX_APKS) throw new Error("The Android archive requires 1–64 APKs.");
    let bytes = 0;
    for (const entry of apks.sort((a, b) => a.name.localeCompare(b.name))) {
      bytes += entry.uncompressedSize;
      if (bytes > LIMITS.extractedBytes) throw new Error("The Android package set exceeds the supported size.");
      if ((entry.externalAttributes >>> 16 & 0xf000) === 0xa000) throw new Error("Linked Android packages are unsupported.");
      const file = path.join(directory, "package-" + outputs.length + ".apk");
      const copied = await archive.copy(entry.name, file, { signal });
      outputs.push({ file, originalName: entry.name, ...copied });
    }
  });
  return outputs;
}

async function inspectInput(input, { signal, profile = {}, requireLauncher = true, inspection = false } = {}) {
  const options = { profile, requireLauncher, inspection };
  if (!ARCHIVES.test(input)) return inspectFiles(directFiles(input), options);
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "maclauncher-apk-inspect-"));
  try { return inspectFiles((await unpack(input, temporary, signal)).map(item => item.file), options); }
  finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { ARCHIVES, MAX_APKS, directFiles, inspectFiles, inspectInput, unpack, plan, installedName };
