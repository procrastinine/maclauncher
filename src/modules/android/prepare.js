const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { inspectApk, withApk, LIMITS: APK_LIMITS } = require("./apk");
const { INSPECTION_VERSION } = require("./binary-manifest");
const Writable = require("../shared/writable-input");
const { copyFileExclusive } = require("../shared/copy-file");
const { runToolCommand } = require("../shared/runtime/tool-command");
const Zip = require("../shared/runtime/zip");
const Storage = require("./storage");
const Cache = require("./prepared-cache");
const Digests = require("./preparation-digests");
const { generationKey, generationPaths, retainPrepared, prunePrepared } = Cache;
const PREPARATION_SCHEMA = 2;
const NATIVE_INSTALL_VERSION = 1;
const nativeLibrary = name => /^lib\/[^/]+\/[^/]+\.so$/.test(name);
// Memory reuse complements the launcher-owned persistent index. Both use the
// same current nanosecond file identity, never a time-based freshness window.
const fileHashes = new Map(), FILE_HASH_CACHE_LIMIT = 8192;
const fileIdentity = Digests.identity;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
function newGeneration(directory, key) {
  const primary = path.join(directory, key);
  return fs.existsSync(primary) ? primary + "-" + crypto.randomBytes(8).toString("hex") : primary;
}
async function existingGeneration(directory, key, signal, digests) {
  for (const root of generationPaths(directory)) {
    if (generationKey(path.basename(root)) !== key) continue;
    const receipt = await existingCache(root, key, signal, digests);
    if (receipt) return { root, receipt };
  }
  return null;
}
async function publishGeneration(temporary, directory, key) {
  for (;;) {
    const root = newGeneration(directory, key);
    try { await fs.promises.rename(temporary, root); return root; }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
  }
}

async function cleanupTemporary(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink() || !/^\.prepare-[A-Za-z0-9]{6}$/.test(item.name)) continue;
    const root = path.join(directory, item.name), marker = path.join(root, ".preparing.json");
    let receipt;
    try {
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.size > 1024) continue;
      receipt = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (receipt.owner !== "maclauncher-android" || receipt.schemaVersion !== 1 ||
        !Number.isInteger(receipt.pid) || receipt.pid < 1 || receipt.pid > 2147483647 ||
        !/^[a-f0-9]{64}$/.test(receipt.key || "")) continue;
      process.kill(receipt.pid, 0);
      continue; // A live preparation process, including another launcher.
    } catch (error) { if (error.code !== "ESRCH") continue; }
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function applicationPaths(entry, userDataDir) {
  const { filesRoot, cacheRoot } = Storage.storagePaths(userDataDir, entry?.gameId);
  return { filesRoot, cacheRoot };
}

async function fileHash(file, signal, digests) {
  signal?.throwIfAborted();
  const key=path.resolve(file),current=fs.lstatSync(file,{bigint:true});
  if(!current.isFile())throw new Error("Android preparation inputs must be regular files.");
  const cached=fileHashes.get(key) || digests?.get(key);
  if(cached?.identity===fileIdentity(current)){
    fileHashes.delete(key);fileHashes.set(key,cached);digests?.set(key,cached);
    if(fileHashes.size>FILE_HASH_CACHE_LIMIT)fileHashes.delete(fileHashes.keys().next().value);
    return cached.sha256;
  }
  const input=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const before=await input.stat({bigint:true});
    if(!before.isFile())throw new Error("Android preparation inputs must be regular files.");
    const identity=fileIdentity(before);
    signal?.throwIfAborted();
    fileHashes.delete(key);
    const digest=crypto.createHash("sha256");
    for await(const chunk of input.createReadStream({autoClose:false,signal}))digest.update(chunk);
    const descriptorAfter=fileIdentity(await input.stat({bigint:true})),pathAfter=fileIdentity(fs.lstatSync(file,{bigint:true}));
    if(descriptorAfter!==identity || pathAfter!==identity)
      throw Object.assign(new Error("An Android preparation file changed while being read."),{
        code:"ANDROID_PREPARATION_INPUT_CHANGED",path:key,identityBefore:identity,identityDescriptorAfter:descriptorAfter,identityPathAfter:pathAfter
      });
    signal?.throwIfAborted();const sha256=digest.digest("hex");
    if(fileHashes.size>=FILE_HASH_CACHE_LIMIT)fileHashes.delete(fileHashes.keys().next().value);
    const value={identity,sha256};fileHashes.set(key,value);digests?.set(key,value);return sha256;
  } catch(error) {fileHashes.delete(key);throw error;}
  finally {await input.close();}
}

// Native copy-on-write copies avoid duplicate storage where supported while
// imports and installed resources retain separate writable file identities.
async function copyOriginal(input, output, expected, signal) {
  signal?.throwIfAborted();
  const source = await fs.promises.open(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || fileIdentity(fs.lstatSync(input, { bigint: true })) !== fileIdentity(before))
      throw new Error("Android preparation inputs must be regular files.");
    await copyFileExclusive(input, output, { signal, mode: 0o600, validate: async staged => {
      const digest = await fileHash(staged, signal);
      if (fileIdentity(await source.stat({ bigint: true })) !== fileIdentity(before) ||
          fileIdentity(fs.lstatSync(input, { bigint: true })) !== fileIdentity(before) || digest !== expected)
        throw new Error("An Android package changed during preparation. Try Play again.");
    } });
  } finally { await source.close(); }
}

async function describePayload(payload, signal, digests, execution = "jvm") {
  if (!["jvm", "art"].includes(execution)) throw new Error("Unknown Android execution engine.");
  if (!path.isAbsolute(payload?.root || "") || !/^[\w.-]{1,128}$/.test(payload?.profile?.id || "") ||
      payload.profile.javaMajor !== 21 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(payload.profile.nativeLoadTarget || ""))
    throw new Error("The Android runtime compatibility profile is invalid.");
  const root = fs.realpathSync(payload.root), groups = {};
  // ART executes the original DEX. Only package metadata tools participate in
  // its preparation; converter availability/bytes belong to the JVM binding.
  const classpaths = execution === "art" ? ["metadataClasspath"] : ["converterClasspath", "metadataClasspath"];
  for (const key of classpaths) {
    const paths = payload[key];
    if (!Array.isArray(paths) || !paths.length) throw new Error("The Android conversion libraries are incomplete.");
    groups[key] = [];
    for (const file of paths) {
      if (!path.isAbsolute(file) || !inside(root, fs.realpathSync(file)) || !fs.lstatSync(file).isFile())
        throw new Error("Android conversion libraries must belong to the installed runtime.");
      groups[key].push({ file, sha256: await fileHash(file, signal, digests) });
    }
  }
  // Key conversion by the actual converter invocation and input bytes. Native
  // service capabilities and runtime paths do not change the generated classes.
  // Deriving this from argumentsFor also picks up future converter options.
  const inputs = { profile: payload.profile, ...Object.fromEntries(Object.entries(groups)
    .map(([key, files]) => [key, files.map(item => ({ file: item.sha256 }))])) };
  if (execution === "art") return { ...groups, execution, profile: payload.profile, identity: hash(JSON.stringify({
    execution, schemaVersion: PREPARATION_SCHEMA, metadata: inputs.metadataClasspath,
    nativeArchitectures: require("./native-abi").supported(payload.profile) })) };
  return { ...groups, profile: payload.profile, identity: hash(JSON.stringify(
    require("./conversion").argumentsFor(inputs, "converted.jar", []))) };
}

async function extractInputs(apk, destination, signal, state = { total: 0, names: new Map(), files: new Set(), base: true }) {
  const extracted = [];
  await withApk(apk, async archive => {
    const selected = archive.entries.filter(entry => !entry.name.endsWith("/") &&
      (state.assets !== false && entry.name.startsWith("assets/") || entry.name.startsWith("lib/" + (state.nativeAbi || "arm64-v8a") + "/") && /^lib\/[^/]+\/[^/]+\.so$/.test(entry.name) ||
       state.base && ["resources.arsc", "AndroidManifest.xml"].includes(entry.name)));
    // Compiled resources keep Android's case-sensitive ZIP namespace in
    // the original APK. They are not ordinary filesystem assets; valid AAPT names
    // can differ only by case on a case-insensitive macOS volume.
    const names = state.names;
    // Validate the complete path set before creating any files. macOS commonly
    // folds case and Unicode names, unlike Android's asset namespace.
    for (const entry of selected) {
      if (state.files.has(entry.name)) throw new Error("The Android packages contain colliding asset or library names.");
      state.files.add(entry.name);
      const parts = entry.name.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const original = parts.slice(0, count).join("/"), folded = original.normalize("NFC").toLowerCase();
        if (names.has(folded) && names.get(folded) !== original) throw new Error("The APK contains colliding asset names.");
        names.set(folded, original);
      }
    }
    for (const entry of selected) {
      signal?.throwIfAborted();
      const mode = entry.externalAttributes >>> 16;
      if ((mode & 0xf000) === 0xa000) throw new Error("The APK contains linked assets.");
      state.total += entry.uncompressedSize;
      if (state.total > APK_LIMITS.extractedBytes) throw new Error("The APK expands beyond the supported size.");
      const output = path.join(destination, ...entry.name.split("/"));
      Writable.assertOwnDirectory(destination, path.dirname(output));
      const result = await archive.copy(entry.name, output, { signal });
      // Android installs native libraries as executables, including ELF helper
      // programs packaged with a .so suffix. ZIP permission bits are not the
      // installed package mode; ordinary assets remain private data files.
      if (nativeLibrary(entry.name)) await fs.promises.chmod(output, 0o700);
      extracted.push({ name: entry.name, ...result });
    }
  });
  return extracted;
}

async function convertSources(runtime, metadata, sources, output, java, execute, tool) {
  if (metadata.dex.length) {
    await execute(java.javaPath, require("./conversion").argumentsFor(runtime, output, sources), tool);
    tool.signal?.throwIfAborted();
    const converted = Zip.readZipEntries(output);
    if (!converted?.entries.length || converted.entries.length !== converted.info.entries ||
        !converted.entries.some(item => item.name.endsWith(".class") || runtime.profile.demandDexVersion === 1 && item.name === "META-INF/maclauncher/demand-dex")) throw new Error("Android conversion produced no Java classes.");
  } else {
    // Original hasCode=false packages use the same classloader without local DEX.
    const empty = Buffer.alloc(22); empty.writeUInt32LE(0x06054b50);
    await fs.promises.writeFile(output, empty, { flag: "wx", mode: 0o600 });
    tool.signal?.throwIfAborted();
  }
}

async function existingCache(directory, key, signal, digests) {
  try {
    Writable.assertOwnDirectory(path.dirname(directory), directory, { create: false });
    const receiptPath = path.join(directory, "prepared.json"), receiptStat = fs.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.size > 16 * 1024 * 1024) return null;
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath, "utf8"));
    if (receipt.schemaVersion !== PREPARATION_SCHEMA || receipt.key !== key || !Array.isArray(receipt.files) ||
        receipt.execution !== undefined && !["jvm", "art"].includes(receipt.execution)) return null;
    if (receipt.assetStorage !== undefined && (receipt.execution !== "art" || receipt.assetStorage !== "apk" ||
        receipt.files.some(file => file.name.startsWith("assets/")))) return null;
    if (receipt.sourceName !== undefined && !["source.apk", require("./package-set").installedName(null)].includes(receipt.sourceName)) return null;
    if (receipt.sources && (![1, 2, 3].includes(receipt.packageSetVersion) || !Array.isArray(receipt.sources) || !receipt.sources.length || receipt.sources.length > 64 ||
        receipt.sources.some((item, i) => item.name !== (receipt.packageSetVersion === 1 ? (i ? "split-" + i + ".apk" : "source.apk") : !i && receipt.packageSetVersion === 2 ? "source.apk" :
          require("./package-set").installedName(i ? item.split : null)) || !/^[a-f0-9]{64}$/.test(item.sha256)))) return null;
    const directories=new Map();
    function verifyDirectory(target) {
      if(directories.has(target))return;
      if(target!==directory)verifyDirectory(path.dirname(target));
      const stat=fs.lstatSync(target,{bigint:true});
      if(!stat.isDirectory())throw new Error("Android preparation directories must not be aliases.");
      directories.set(target,[stat.dev,stat.ino].join(":"));
    }
    for (const file of [...(receipt.sources || [{ name: receipt.sourceName || "source.apk", sha256: receipt.apkSha256 }]), ...(receipt.execution === "art" ? [] : [{ name: "converted.jar", sha256: receipt.convertedSha256 }]),
      // ART's original AssetManager reads these entries from the verified APKs.
      // Legacy extracted copies are not inputs to this execution engine.
      ...receipt.files.filter(item => receipt.execution !== "art" || !item.name.startsWith("assets/"))
        .map(item => ({ ...item, name: "input/" + item.name }))]) {
      const target = path.resolve(directory, file.name);
      if (target === directory || !inside(directory, target)) return null;
      verifyDirectory(path.dirname(target));
      if (await fileHash(target, signal, digests) !== file.sha256) return null;
    }
    // Each ancestor is checked once per pass, and again after file validation:
    // replacing a checked directory with an alias cannot validate a generation.
    for(const [target,identity] of directories){
      const stat=fs.lstatSync(target,{bigint:true});
      if(!stat.isDirectory() || [stat.dev,stat.ino].join(":")!==identity)return null;
    }
    // Read missing metadata from the verified original instead of guessing
    // flags or treating an uninspected application Bundle as empty.
    if (receipt.metadata?.manifestInspectionVersion !== INSPECTION_VERSION ||
        typeof receipt.metadata?.debuggable !== "boolean" || typeof receipt.metadata?.hasCode !== "boolean" ||
        typeof receipt.metadata?.applicationMetadataInspected !== "boolean" ||
        typeof receipt.metadata?.applicationIconInspected !== "boolean" ||
        typeof receipt.metadata?.applicationComponentsInspected !== "boolean") {
      receipt.metadata = receipt.sources ? require("./package-set").inspectFiles(receipt.sources.map(item => path.join(directory, item.name)), { profile: receipt.profile }).metadata :
        inspectApk(path.join(directory, receipt.sourceName || "source.apk"), { nativeArchitectures: require("./native-abi").supported(receipt.profile) });
      receipt.metadata.nativeAbi ??= require("./native-abi").select(receipt.metadata.architectures, receipt.profile);
      signal?.throwIfAborted();
      Writable.atomicWrite(receiptPath, JSON.stringify(receipt), { root: directory });
    }
    return receipt;
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

async function retainInstalledNames(directory, receipt, signal) {
  const Package = require("./package-set"), base = Package.installedName(null);
  if (receipt.sources ? receipt.packageSetVersion === 3 : receipt.sourceName === base) return receipt;
  const originals = receipt.sources || [{ name: receipt.sourceName || "source.apk", sha256: receipt.apkSha256, split: null }], sources = [];
  // Verify first, then publish the canonical install layout without converting
  // bytecode or copying APK bytes. Receipt replacement is the commit point.
  for (const source of originals) {
    signal?.throwIfAborted();
    const original = path.join(directory, source.name);
    const split = receipt.packageSetVersion === 1 ? inspectApk(original).split : source.split;
    const name = Package.installedName(split), target = path.join(directory, name);
    if (name !== source.name) {
      try { await fs.promises.link(original, target); }
      catch (error) {
        if (error.code !== "EEXIST" || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() ||
            await fileHash(target, signal) !== source.sha256) throw error;
      }
    }
    sources.push({ ...source, name, split });
  }
  const updated = receipt.sources ? { ...receipt, packageSetVersion: 3, sources } : { ...receipt, sourceName: base };
  Writable.atomicWrite(path.join(directory, "prepared.json"), JSON.stringify(updated), { root: directory });
  for (let i = 0; i < sources.length; i++) if (originals[i].name !== sources[i].name)
    await fs.promises.unlink(path.join(directory, originals[i].name));
  return updated;
}

async function installedGeneration(directory, selected, signal) {
  const { root } = selected;
  const receipt = selected.receipt = await Cache.retireExtractedAssets(root, selected.receipt, signal);
  if (receipt.nativeInstallVersion !== NATIVE_INSTALL_VERSION) {
    // Permission-only migration preserves converted bytes and active readers.
    // The preparation lock and verified receipt own these extracted files.
    for (const file of receipt.files.filter(item => nativeLibrary(item.name))) {
      signal?.throwIfAborted();
      const handle = await fs.promises.open(path.join(root, "input", file.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); } finally { await handle.close(); }
    }
    receipt.nativeInstallVersion = NATIVE_INSTALL_VERSION;
    Writable.atomicWrite(path.join(root, "prepared.json"), JSON.stringify(receipt), { root });
  }
  if (receipt.sources ? receipt.packageSetVersion === 3 : receipt.sourceName === require("./package-set").installedName(null)) return selected;
  const temporary = await fs.promises.mkdtemp(path.join(directory, ".prepare-"));
  try {
    Writable.atomicWrite(path.join(temporary, ".preparing.json"), JSON.stringify({ owner: "maclauncher-android", schemaVersion: 1, pid: process.pid, key: receipt.key }), { root: temporary });
    // Published preparation paths belong to their live readers. Clone immutable
    // inputs before changing filenames, retaining old paths and avoiding another
    // conversion. Native clones share storage where the filesystem supports it.
    const files = [...(receipt.sources || [{ name: receipt.sourceName || "source.apk" }]),
      ...(receipt.execution === "art" ? [] : [{ name: "converted.jar" }]), ...receipt.files.map(file => ({ name: "input/" + file.name }))];
    for (const file of files) {
      signal?.throwIfAborted();
      const target = path.resolve(temporary, file.name);
      if (!inside(temporary, target)) throw new Error("Android preparation contains an invalid file path.");
      Writable.assertOwnDirectory(temporary, path.dirname(target));
      await copyFileExclusive(path.join(root, file.name), target, { signal });
    }
    for (const name of ["assets", "lib/" + (receipt.metadata.nativeAbi || "arm64-v8a")])
      Writable.assertOwnDirectory(temporary, path.join(temporary, "input", name));
    Writable.atomicWrite(path.join(temporary, "prepared.json"), JSON.stringify(receipt), { root: temporary });
    if (!await existingCache(temporary, receipt.key, signal)) throw new Error("Android preparation changed during installation.");
    const updated = await retainInstalledNames(temporary, receipt, signal);
    signal?.throwIfAborted();
    const installed = await publishGeneration(temporary, directory, receipt.key);
    await fs.promises.rm(path.join(installed, ".preparing.json"), { force: true });
    return { root: installed, receipt: updated };
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

async function prepareApk(entry, { userDataDir, payload, java, signal, onToolProcessSpawn, execute = runToolCommand, requireLauncher = true, retain = false, execution = "jvm" } = {}) {
  if (entry?.moduleData?.packageSet === true || /\.(?:xapk|apkm|apks)$/i.test(entry?.gamePath || "") ||
      entry?.gamePath && fs.existsSync(entry.gamePath) && fs.lstatSync(entry.gamePath).isDirectory())
    return require("./prepare-set").prepareSet(entry, { userDataDir, payload, java, signal, onToolProcessSpawn, execute, requireLauncher, retain, execution });
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "") ||
    !path.isAbsolute(entry?.gamePath || "") || !/\.apk$/i.test(entry.gamePath)) throw new Error("Android preparation requires a saved APK game.");
  if (!java?.javaPath || java.variant !== "arm64" || Number(java.line) !== 21) throw new Error("Android games require Apple Silicon Java 21.");
  signal?.throwIfAborted();
  const storage = await Storage.prepareStorage(entry, userDataDir, { signal, payloadRoot: payload.root });
  const gameRoot = storage.root;
  const cacheRoot = storage.preparedRoot;
  Writable.assertOwnDirectory(userDataDir, cacheRoot);
  return Cache.locked(cacheRoot, async () => {
    signal?.throwIfAborted();
    const digests=Digests.open(gameRoot);
    const runtime = await describePayload(payload, signal, digests, execution);
    const apkSha256 = await fileHash(entry.gamePath, signal, digests);
    const key = hash(JSON.stringify({ schemaVersion: PREPARATION_SCHEMA, apkSha256, payload: runtime.identity, nativeArchitectures: runtime.profile.arm32Version === 1 ? require("./native-abi").supported(runtime.profile) : undefined }));
    await cleanupTemporary(cacheRoot);
    const selected = await existingGeneration(cacheRoot, key, signal, digests);
    const installed = selected && await installedGeneration(cacheRoot, selected, signal);
    let receipt = installed?.receipt, destination = installed?.root;
    if (!receipt) {
      const temporary = await fs.promises.mkdtemp(path.join(cacheRoot, ".prepare-"));
      try {
        Writable.atomicWrite(path.join(temporary, ".preparing.json"), JSON.stringify({
          owner: "maclauncher-android", schemaVersion: 1, pid: process.pid, key }), { root: temporary });
        const sourceName = require("./package-set").installedName(null), source = path.join(temporary, sourceName);
        await copyOriginal(entry.gamePath, source, apkSha256, signal);
        const metadata = inspectApk(source, { requireLauncher, nativeArchitectures: require("./native-abi").supported(runtime.profile) });
        metadata.nativeAbi = require("./native-abi").select(metadata.architectures, runtime.profile);
        if (metadata.limitations.length) throw new Error(metadata.limitations.join(" "));
        const input = path.join(temporary, "input"); Writable.assertOwnDirectory(temporary, input);
        const files = await extractInputs(source, input, signal, { total: 0, names: new Map(), files: new Set(), base: true, nativeAbi: metadata.nativeAbi, assets: execution !== "art" });
        for (const folder of ["assets", "lib/" + metadata.nativeAbi]) Writable.assertOwnDirectory(input, path.join(input, folder));
        const output = path.join(temporary, "converted.jar"), logPath = path.join(gameRoot, "conversion.log");
        const environment = { ...process.env };
        for (const name of Object.keys(environment)) if (/^(DYLD_|RESHADE_|DEX2JVM_)/.test(name) ||
          ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"].includes(name)) delete environment[name];
        if (execution === "jvm") await convertSources(runtime, metadata, [source], output, java, execute,
          { cwd: temporary, env: environment, logPath, signal, timeout: 180000, onSpawn: onToolProcessSpawn });
        receipt = { schemaVersion: PREPARATION_SCHEMA, nativeInstallVersion: NATIVE_INSTALL_VERSION, key, apkSha256, payloadIdentity: runtime.identity, profile: runtime.profile,
          sourceName, metadata, ...(execution === "art" ? { execution, assetStorage: "apk" } : { convertedSha256: await fileHash(output, signal) }), files };
        Writable.atomicWrite(path.join(temporary, "prepared.json"), JSON.stringify(receipt), { root: temporary });
        destination = await publishGeneration(temporary, cacheRoot, key);
        await fs.promises.rm(path.join(destination, ".preparing.json"), { force: true });
      } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
    }
    if (requireLauncher && !receipt.metadata.launchers.length) throw new Error("The APK has no enabled launcher activity.");
    const data = applicationPaths(entry, userDataDir, payload.root);
    const expansions=await require("./expansions").installExpansions(entry.gamePath,receipt.metadata.packageName,storage.dataRoot,{signal});
    digests.save();
    const now = new Date(); fs.utimesSync(destination, now, now);
    return Cache.finishLocked({ ...receipt, profile: runtime.profile, root: destination, sourceApk: path.join(destination, receipt.sourceName), ...(receipt.execution === "art" ? {} : { convertedJar: path.join(destination, "converted.jar") }),
      assetsRoot: path.join(destination, "input", "assets"), nativeRoot: path.join(destination, "input", "lib", receipt.metadata.nativeAbi || "arm64-v8a"),
      resourcesRoot: path.join(destination, "input"), expansions, ...data }, retain, {signal});
  });
}

module.exports = { describePayload, extractInputs, convertSources, existingCache, existingGeneration, installedGeneration, publishGeneration, retainInstalledNames, fileHash, copyOriginal, prepareApk, retainPrepared, prunePrepared, cleanupTemporary, applicationPaths };
