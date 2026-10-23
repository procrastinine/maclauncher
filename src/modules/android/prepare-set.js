const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Package = require("./package-set"), { inspectApk } = require("./apk");
const Writable = require("../shared/writable-input");
const Prep = require("./prepare");
const Cache = require("./prepared-cache");
const Storage = require("./storage");
const Digests = require("./preparation-digests");
const digest = data => crypto.createHash("sha256").update(data).digest("hex");

function environment() {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (/^(DYLD_|RESHADE_|DEX2JVM_|KL_|KLEPTON_)/.test(key) ||
    ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"].includes(key)) delete result[key];
  return result;
}

async function prepareSet(entry, options) {
  const { userDataDir, payload, java, signal, onToolProcessSpawn, execute, retain, requireLauncher = true, execution = "jvm" } = options;
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "") || !path.isAbsolute(entry?.gamePath || ""))
    throw new Error("Android preparation requires a saved package set.");
  if (payload?.profile?.splitApksVersion !== 1) throw new Error("The included Android runtime does not support split APK packages. Update MacLauncher.");
  if (!java?.javaPath || java.variant !== "arm64" || Number(java.line) !== 21) throw new Error("Android games require Apple Silicon Java 21.");
  signal?.throwIfAborted();
  const archive = Package.ARCHIVES.test(entry.gamePath);
  const inputs = archive ? [entry.gamePath] : Package.directFiles(entry.gamePath);
  if (!archive && inputs.reduce((bytes, file) => bytes + fs.lstatSync(file).size, 0) > 4 * 1024 ** 3)
    throw new Error("The Android package set exceeds the supported size.");
  const storage = await Storage.prepareStorage(entry, userDataDir, { signal, payloadRoot: payload.root });
  const gameRoot = storage.root;
  const cacheRoot = storage.preparedRoot;
  Writable.assertOwnDirectory(userDataDir, cacheRoot);
  return Cache.locked(cacheRoot, async () => {
    signal?.throwIfAborted();
    const digests=Digests.open(gameRoot),runtime=await Prep.describePayload(payload,signal,digests,execution);
    const hashes = [];
    for (const file of inputs) hashes.push({ file, sha256: await Prep.fileHash(file, signal, digests) });
    const key = digest(JSON.stringify({ schemaVersion: 2, packageSetVersion: 1,
      originals: hashes.map(item => [path.basename(item.file), item.sha256]), payload: runtime.identity, nativeArchitectures: runtime.profile.arm32Version === 1 ? require("./native-abi").supported(runtime.profile) : undefined }));
    await Prep.cleanupTemporary(cacheRoot);
    const selected = await Prep.existingGeneration(cacheRoot, key, signal,digests);
    const installed = selected && await Prep.installedGeneration(cacheRoot, selected, signal);
    let receipt = installed?.receipt, destination = installed?.root;
    if (!receipt) {
      const temporary = await fs.promises.mkdtemp(path.join(cacheRoot, ".prepare-"));
      try {
        Writable.atomicWrite(path.join(temporary, ".preparing.json"), JSON.stringify({ owner: "maclauncher-android", schemaVersion: 1, pid: process.pid, key }), { root: temporary });
        const packages = path.join(temporary, "packages"); Writable.assertOwnDirectory(temporary, packages);
        let copied;
        if (archive) {
          copied = await Package.unpack(entry.gamePath, packages, signal);
          if (await Prep.fileHash(entry.gamePath, signal) !== hashes[0].sha256) throw new Error("The Android archive changed during preparation.");
        } else {
          copied = [];
          for (const item of hashes) {
            const file = path.join(packages, "package-" + copied.length + ".apk");
            await Prep.copyOriginal(item.file, file, item.sha256, signal);
            copied.push({ file, sha256: item.sha256, originalName: path.basename(item.file) });
          }
        }
        const logPath = path.join(gameRoot, "conversion.log"), reportPath = path.join(temporary, "signatures.tsv");
        const tool = { cwd: temporary, env: environment(), logPath, signal, timeout: 180000, onSpawn: onToolProcessSpawn };
        // Both execution engines verify original package signatures. ART's
        // conversion cache deliberately excludes converter inputs, but its
        // trusted installed payload still supplies this package-verifier tool.
        const classpath = (runtime.converterClasspath?.map(item => item.file) || payload.converterClasspath).join(path.delimiter);
        await execute(java.javaPath, ["-Xmx256m", "-cp", classpath, "io.github.kksimp.dex2jvm.VerifyApkSet", reportPath, ...copied.map(item => item.file)], tool);
        const reportStat = await fs.promises.lstat(reportPath);
        if (!reportStat.isFile() || reportStat.size > 65536) throw new Error("Android package verification returned an invalid result.");
        const lines = (await fs.promises.readFile(reportPath, "utf8")).trim().split("\n");
        if (lines.length !== copied.length) throw new Error("Android package verification is incomplete.");
        const records = copied.map((item, index) => {
          const [position, sha256, certs] = lines[index].split("\t");
          if (position !== String(index) || sha256 !== item.sha256) throw new Error("The verified Android package identity differs from its source.");
          return { ...item, metadata: inspectApk(item.file), signers: (certs || "").split(",") };
        });
        const selected = Package.plan(records, { verified: true, profile: runtime.profile, requireLauncher });
        if (selected.metadata.limitations.length) throw new Error(selected.metadata.limitations.join(" "));
        const sources = [];
        for (const item of selected.selected) {
          const name = Package.installedName(item.metadata.split);
          await fs.promises.rename(item.file, path.join(temporary, name));
          sources.push({ name, sha256: item.sha256, signers: item.signers, originalName: item.originalName, split: item.metadata.split });
        }
        await fs.promises.rm(packages, { recursive: true, force: true });
        await fs.promises.rm(reportPath);
        const input = path.join(temporary, "input"); Writable.assertOwnDirectory(temporary, input);
        const state = { total: 0, names: new Map(), files: new Set(), base: true, nativeAbi: selected.metadata.nativeAbi, assets: execution !== "art" }, files = [];
        for (const source of sources) { files.push(...await Prep.extractInputs(path.join(temporary, source.name), input, signal, state)); state.base = false; }
        for (const name of ["assets", "lib/" + selected.metadata.nativeAbi]) Writable.assertOwnDirectory(input, path.join(input, name));
        const output = path.join(temporary, "converted.jar");
        if (execution === "jvm") await Prep.convertSources(runtime, selected.metadata, sources.map(item => path.join(temporary, item.name)), output, java, execute, tool);
        signal?.throwIfAborted();
        receipt = { schemaVersion: 2, nativeInstallVersion: 1, packageSetVersion: 3, key, apkSha256: sources[0].sha256,
          sources, payloadIdentity: runtime.identity, profile: runtime.profile, metadata: selected.metadata,
          ...(execution === "art" ? { execution, assetStorage: "apk" } : { convertedSha256: await Prep.fileHash(output, signal) }), files };
        Writable.atomicWrite(path.join(temporary, "prepared.json"), JSON.stringify(receipt), { root: temporary });
        destination = await Prep.publishGeneration(temporary, cacheRoot, key);
        await fs.promises.rm(path.join(destination, ".preparing.json"), { force: true });
      } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
    }
    if (requireLauncher && !receipt.metadata.launchers.length) throw new Error("The APK has no enabled launcher activity.");
    const data = Prep.applicationPaths(entry, userDataDir, payload.root), now = new Date(); fs.utimesSync(destination, now, now);
    const expansions=await require("./expansions").installExpansions(entry.gamePath,receipt.metadata.packageName,storage.dataRoot,{archive,signal});
    digests.save();
    return Cache.finishLocked({ ...receipt, profile: runtime.profile, root: destination, sourceApk: path.join(destination, receipt.sources[0].name),
      sourceApks: receipt.sources.map(item => path.join(destination, item.name)), ...(receipt.execution === "art" ? {} : { convertedJar: path.join(destination, "converted.jar") }),
      assetsRoot: path.join(destination, "input/assets"), nativeRoot: path.join(destination, "input/lib", receipt.metadata.nativeAbi || "arm64-v8a"), resourcesRoot: path.join(destination, "input"), expansions, ...data }, retain, {signal});
  });
}

module.exports = { prepareSet };
